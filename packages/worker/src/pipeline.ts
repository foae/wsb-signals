/**
 * Pipeline glue — TS port of `aggregate.run_aggregation` + `analytical.overlay_market` (porting-spec §7).
 * These tie the pure scorers (aggregate.ts, market.ts) to the Postgres reads/writes. Persistence of the
 * CURRENT window is deferred to the atomic `publishCycle` (db.ts); only the W−1 finalize persists here.
 */
import type { AnalyticalFeatureInsert, MarketMoverInsert, SignalInsert } from '@wsb/shared'

import { aggregateWindow, type AggregateInputs, type EmpiricalFeature, type HeatWeights } from './aggregate'
import {
  classifyQuadrant, divergence, leadLagHours, median, type SignalsConfig,
} from './analytics'
import {
  readAnalyticalHmAt, readBoardHeCells, readFeatureHistory, readFeaturesAt, readHeRanksAt,
  readMentionsInWindow, readOverlaidCells, readSignalSeries, readSovRanksAt, upsertEmpiricalFeatures,
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
  opts: {
    persist: boolean
    /** Live-shadow hook (slice 9): receives the EXACT inputs `aggregateWindow` consumed, so the cycle can
     *  dump them for the deterministic replay-vs-oracle diff. Undefined off the shadow path (zero overhead). */
    onInputs?: (inputs: AggregateInputs) => void
  },
): Promise<EmpiricalFeature[]> {
  const mentionsInWindow = await readMentionsInWindow(db, windowStart, windowStart + cfg.windowSeconds)
  if (mentionsInWindow.length === 0) return [] // Python `if not rows: return []` — skip the prior reads

  const priorFeatures = await readFeaturesAt(db, windowStart - cfg.windowSeconds)
  const priorSovRanks = await readSovRanksAt(db, windowStart - cfg.windowSeconds)
  const featureHistory = await readFeatureHistory(db, windowStart)

  const inputs: AggregateInputs = {
    windowStart,
    windowSeconds: cfg.windowSeconds,
    weights: cfg.weights,
    minSamplesReady: cfg.minSamplesReady,
    minAuthorsFull: cfg.minAuthorsFull,
    mentionsInWindow,
    priorFeatures,
    priorSovRanks,
    featureHistory,
  }
  opts.onInputs?.(inputs)
  const rows = aggregateWindow(inputs)

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

/**
 * Build the Attention×Action signals for window W (slice 7 — NEW, no oracle; see analytics.ts). Joins the
 * just-computed empirical board (`rows`, canonical order) with the window's H_m, derives divergence +
 * quadrant + the H_e-rank delta + lead-lag, and returns the `signals` rows for the atomic publish (it does
 * NOT persist — publishCycle does).
 *
 * `freshAnalytical` is this cycle's overlay when it succeeded; when it's undefined (market failed / absent,
 * so publishCycle is PRESERVING the prior overlay), the effective H_m is read back from the committed
 * `analytical_features` at W — so the signals always reflect the H_m that the window will actually carry.
 */
export async function buildSignals(
  db: Db,
  windowStart: number,
  windowSeconds: number,
  cfg: SignalsConfig,
  rows: readonly EmpiricalFeature[],
  freshAnalytical: readonly AnalyticalFeatureInsert[] | undefined,
): Promise<SignalInsert[]> {
  if (rows.length === 0) return []

  // Effective H_m at W: this cycle's overlay if present, else the committed/preserved overlay.
  const hmByTicker = freshAnalytical
    ? new Map(freshAnalytical.flatMap((a) => (a.hM != null ? [[a.ticker, a.hM] as const] : [])))
    : await readAnalyticalHmAt(db, windowStart)
  const from = windowStart - cfg.medianLookbackSeconds

  // Global rolling-median split, with DIFFERENT populations per axis (M3 fix): H_e over the trailing FULL
  // board (so "WSB quiet" = genuinely low attention, not just below the hottest top-N) and H_m over the
  // trailing OVERLAID cells (only they have market data). Both include this window's own cells — W isn't
  // committed yet, so it isn't in the history reads. A quadrant is assigned only once the limiting
  // (overlaid) population clears `minQuadrantPopulation`, so a 1–2-cell cold start can't make a degenerate split.
  const boardHeHistory = await readBoardHeCells(db, from, windowStart)
  const overlaidHistory = await readOverlaidCells(db, from, windowStart)
  const currentOverlaidHm: number[] = []
  for (const r of rows) {
    const hm = hmByTicker.get(r.ticker)
    if (hm != null) currentOverlaidHm.push(hm)
  }
  const thrHe = median([...boardHeHistory, ...rows.map((r) => r.hE)])
  const thrHm = median([...overlaidHistory.map((c) => c.hM), ...currentOverlaidHm])
  const overlaidPopulation = overlaidHistory.length + currentOverlaidHm.length
  const canQuadrant = thrHe != null && thrHm != null && overlaidPopulation >= cfg.minQuadrantPopulation

  // rank = canonical board index (rows is already sorted); rank_delta vs the prior window's H_e ranks.
  const priorRanks = await readHeRanksAt(db, windowStart - windowSeconds)

  // Lead-lag (DISABLED by default — see analytics.LeadLagConfig). When on: only currently-overlaid tickers
  // (need both axes; bounded to ≤ top-N). Read each one's trailing H_e/H_m series and append this window's point.
  const overlaid = [...hmByTicker.keys()]
  const leadLag = new Map<string, number | null>()
  if (cfg.leadLag.enabled) {
    const series = await readSignalSeries(db, overlaid, windowStart - cfg.leadLag.lookbackSeconds, windowStart)
    const hEnow = new Map(rows.map((r) => [r.ticker, r.hE]))
    for (const t of overlaid) {
      const pts = series.get(t) ?? []
      pts.push({ windowStart, hE: hEnow.get(t) ?? null, hM: hmByTicker.get(t) ?? null })
      leadLag.set(t, leadLagHours(pts, windowSeconds, cfg.leadLag))
    }
  }

  return rows.map((r, i) => {
    const hM = hmByTicker.get(r.ticker) ?? null
    const prior = priorRanks[r.ticker]
    return {
      ticker: r.ticker,
      windowStart,
      hE: r.hE,
      hM,
      divergence: hM != null ? divergence(r.hE, hM) : null,
      quadrant: hM != null && canQuadrant ? classifyQuadrant(r.hE, hM, thrHe, thrHm) : null,
      rank: i + 1,
      rankDelta: prior != null ? prior - (i + 1) : null,
      leadLagHrs: hM != null ? (leadLag.get(r.ticker) ?? null) : null,
    }
  })
}
