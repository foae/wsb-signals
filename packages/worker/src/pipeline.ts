/**
 * Pipeline glue — TS port of `aggregate.run_aggregation` + `analytical.overlay_market` (porting-spec §7).
 * These tie the pure scorers (aggregate.ts, market.ts) to the Postgres reads/writes. Persistence of the
 * CURRENT window is deferred to the atomic `publishCycle` (db.ts); only the W−1 finalize persists here.
 */
import type { AnalyticalFeatureInsert, MarketMoverInsert } from '@wsb/shared'

import { aggregateWindow, type EmpiricalFeature, type HeatWeights } from './aggregate'
import {
  readFeatureHistory, readFeaturesAt, readMentionsInWindow, readSovRanksAt, upsertEmpiricalFeatures,
  type Db,
} from './db'
import { log } from './logger'
import { computeAnalytical, type MarketData, type MarketWeights } from './market'

export interface AggregateConfig {
  windowSeconds: number
  weights: HeatWeights
  minSamplesReady: number
  minAuthorsFull: number
}

export interface MarketConfig {
  topN: number
  screenerTop: number
  weights: MarketWeights
}

/**
 * Aggregate the window starting at `windowStart`: read the four inputs from Postgres, run
 * `aggregateWindow`, and (when `persist`) upsert the features. `persist` is true ONLY for the W−1
 * finalize pass — its writes must COMMIT (autocommit, no surrounding tx) before the current window's
 * reads run (porting-spec §7). The current window's features are written atomically by `publishCycle`,
 * so it is aggregated with `persist:false`.
 */
export async function runAggregation(
  db: Db,
  windowStart: number,
  cfg: AggregateConfig,
  opts: { persist: boolean },
): Promise<EmpiricalFeature[]> {
  const mentionsInWindow = await readMentionsInWindow(db, windowStart, windowStart + cfg.windowSeconds)
  if (mentionsInWindow.length === 0) return [] // Python `if not rows: return []` — skip the prior reads

  const priorFeatures = await readFeaturesAt(db, windowStart - cfg.windowSeconds)
  const priorSovRanks = await readSovRanksAt(db, windowStart - cfg.windowSeconds)
  const featureHistory = await readFeatureHistory(db, windowStart)

  const rows = aggregateWindow({
    windowStart,
    windowSeconds: cfg.windowSeconds,
    weights: cfg.weights,
    minSamplesReady: cfg.minSamplesReady,
    minAuthorsFull: cfg.minAuthorsFull,
    mentionsInWindow,
    priorFeatures,
    priorSovRanks,
    featureHistory,
  })

  // The W−1 finalize persists in ONE transaction so a crash can't leave the prior window's baseline
  // half-written across the ≤1000-row chunks. (This doesn't defeat the self-heal: a rolled-back W−1 is
  // simply re-aggregated, idempotently, next cycle.)
  if (opts.persist && rows.length) await db.transaction((tx) => upsertEmpiricalFeatures(tx, rows))
  return rows
}

/**
 * Market overlay (best-effort): gate to the top-N hot tickers, fetch snapshots → `H_m`, fetch screeners.
 * Returns the rows for the atomic publish; it does NOT persist (publishCycle does).
 *
 * Failure handling mirrors the oracle's split: a SNAPSHOTS failure propagates (runCycle catches it and
 * preserves the prior overlay — never-kill, porting-spec §7); a SCREENERS failure is swallowed here so a
 * successful `analytical` is still returned (the oracle persists analytical BEFORE fetching screeners).
 */
export async function overlayMarket(
  market: MarketData,
  windowStart: number,
  rows: readonly EmpiricalFeature[],
  cfg: MarketConfig,
  now: number,
): Promise<{ analytical: AnalyticalFeatureInsert[]; movers: MarketMoverInsert[] }> {
  const top = rows.slice(0, cfg.topN).map((r) => r.ticker)
  const snaps = await market.snapshots(top, now)
  const analytical = computeAnalytical(snaps.values(), windowStart, cfg.weights)

  let movers: MarketMoverInsert[] = []
  try {
    movers = await market.screeners(cfg.screenerTop, now)
  } catch (e) {
    log.warn({ err: String(e) }, 'screeners failed — keeping analytical, skipping movers this cycle')
  }
  return { analytical, movers }
}
