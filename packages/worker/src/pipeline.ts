/**
 * Pipeline glue — the pure scorers plus Postgres orchestration. Current W publishes atomically; W−1
 * refreshes empirical features and dependent signals together so longitudinal rows never drift.
 */
import type { AnalyticalFeatureInsert, MarketMoverInsert, SignalInsert } from '@wsb/shared'

import { aggregateWindow, hourOfWeek, type AggregateInputs, type EmpiricalFeature, type HeatWeights } from './aggregate'
import {
  classifyQuadrant, divergence, leadLagHours, median, type SignalsConfig,
} from './analytics'
import {
  markWindowFinalized, markWindowRepaired, readAnalyticalHmAt, readBoardHeCells,
  readCompleteWindowsInRange, readEarliestRemovedWindowNeedingRepair, readEmpiricalBoardAt,
  readFeatureHistory, readFeaturesAt, readHeRanksAt, readMentionsInWindow, readOverlaidCells,
  readSignalSeries, readSovRanksAt, readUnfinalizedWindows, replaceHeatWindow,
  upsertEmpiricalFeatures, type Db, type HeatWindowStamp,
} from './db'
import { log } from './logger'
import {
  computeAnalytical, type MarketData, type MarketNormalization, type MarketProfile, type MarketWeights,
} from './market'

export interface AggregateConfig {
  windowSeconds: number
  weights: HeatWeights
  minSamplesReady: number
  /** Trailing window (seconds) the z-baseline read is bounded to — v2's deliberate divergence from the
   *  oracle's all-time `feature_history` (porting-spec §2.7). Keeps the per-cycle read O(lookback). */
  baselineLookbackSeconds: number
  minAuthorsFull: number
}

export interface MarketConfig {
  topN: number
  screenerTop: number
  weights: MarketWeights
  normalization: MarketNormalization
}

export interface MarketOverlayResult {
  analytical: AnalyticalFeatureInsert[]
  movers: MarketMoverInsert[]
  requested: number
  usable: number
  asOf: number | null
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
  // Bounded z-baseline read (porting-spec §2.7): only the same-hour-of-week rows within the trailing
  // lookback — the exact subset aggregateWindow's baseline uses. `how` is computed by the SAME hourOfWeek
  // the scorer applies, so the SQL pre-filter and the scorer's internal filter never disagree.
  const featureHistory = await readFeatureHistory(
    db, windowStart, windowStart - cfg.baselineLookbackSeconds, hourOfWeek(windowStart),
  )

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
  const rows = aggregateWindow(inputs)

  // Optional persistence remains for isolated callers/tests. The live loop uses `persist:false` and
  // commits empirical features with their dependent signals in `refreshPriorWindow`/`publishCycle`.
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
): Promise<MarketOverlayResult> {
  const top = rows.slice(0, cfg.topN).map((row) => row.ticker)
  const snaps = await market.snapshots(top, now) // may throw — loop owns never-kill
  let profiles = new Map<string, MarketProfile>()
  try {
    profiles = await market.profiles?.(top, now) ?? new Map()
  } catch (error) {
    log.warn({ err: String(error) }, 'market profiles failed — using conservative snapshot baselines')
  }
  const analytical = computeAnalytical(snaps.values(), windowStart, cfg.weights, profiles, cfg.normalization)
  const usableRows = analytical.filter((a) => a.hM != null)
  const asOf = usableRows.length > 0 && usableRows.every((a) => a.asOf != null)
    ? Math.min(...usableRows.map((a) => a.asOf!))
    : null

  let movers: MarketMoverInsert[] = []
  try {
    movers = await market.screeners(cfg.screenerTop, now)
  } catch (e) {
    log.warn({ err: String(e) }, 'screeners failed — keeping analytical, skipping movers this cycle')
  }
  return { analytical, movers, requested: top.length, usable: usableRows.length, asOf }
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
      quadrant: hM != null && canQuadrant && r.authors >= cfg.minRowAuthors
        ? classifyQuadrant(r.hE, hM, thrHe, thrHm)
        : null,
      rank: i + 1,
      rankDelta: prior != null ? prior - (i + 1) : null,
      leadLagHrs: hM != null ? (leadLag.get(r.ticker) ?? null) : null,
    }
  })
}


/** Re-aggregate provisional W−1 and commit its empirical rows and dependent signals atomically. */
export async function refreshPriorWindow(
  db: Db,
  windowStart: number,
  windowSeconds: number,
  aggregateCfg: AggregateConfig,
  signalsCfg: SignalsConfig,
): Promise<void> {
  const rows = await runAggregation(db, windowStart, aggregateCfg, { persist: false })
  const signalRows = await buildSignals(db, windowStart, windowSeconds, signalsCfg, rows, undefined)
  await db.transaction((tx) => replaceHeatWindow(tx, windowStart, rows, signalRows))
}

export interface HeatRepairStamp extends HeatWindowStamp {
  minWindowMentions: number
}

/** Rebuild newly removal-affected history forward so momentum/baseline dependencies also converge. */
export async function repairRemovedHeatHistory(
  db: Db,
  currentWindowStart: number,
  windowSeconds: number,
  aggregateCfg: AggregateConfig,
  signalsCfg: SignalsConfig,
  stamp: HeatRepairStamp,
): Promise<number> {
  const through = currentWindowStart - 2 * windowSeconds
  const earliest = await readEarliestRemovedWindowNeedingRepair(
    db, windowSeconds, through, stamp.repairVersion,
  )
  if (earliest == null) return 0
  const windows = await readCompleteWindowsInRange(db, earliest, through)
  let repaired = 0
  for (const ws of windows) {
    try {
      const rows = await runAggregation(db, ws, aggregateCfg, { persist: false })
      const signalRows = await buildSignals(db, ws, windowSeconds, signalsCfg, rows, undefined)
      const totalMentions = rows.reduce((sum, row) => sum + row.mentions, 0)
      await db.transaction(async (tx) => {
        await replaceHeatWindow(tx, ws, rows, signalRows)
        await markWindowFinalized(tx, ws, stamp)
        await markWindowRepaired(tx, ws, {
          ...stamp,
          totalMentions,
          quiet: totalMentions < stamp.minWindowMentions,
        })
      })
      repaired++
    } catch (error) {
      // Momentum and baselines flow forward: continuing past a broken window would certify stale
      // downstream derivatives. Leave this and later rows unstamped, but let the worker boot.
      log.error({ windowStart: ws, err: String(error) },
        'removed-content heat repair stopped at malformed window')
      break
    }
  }
  if (repaired) log.info({ windows: repaired }, 'repaired heat history after source removals')
  return repaired
}

/** Rebuild and finalize every stable pre-contract/gap window, oldest first. Safe to run every cycle. */
export async function repairFinalizedSignalDrift(
  db: Db,
  currentWindowStart: number,
  windowSeconds: number,
  signalsCfg: SignalsConfig,
  stamp: HeatWindowStamp,
): Promise<number> {
  const windows = await readUnfinalizedWindows(db, currentWindowStart - 2 * windowSeconds)
  let finalized = 0
  for (const ws of windows) {
    try {
      const rows = await readEmpiricalBoardAt(db, ws)
      const signalRows = await buildSignals(db, ws, windowSeconds, signalsCfg, rows, undefined)
      await db.transaction(async (tx) => {
        await replaceHeatWindow(tx, ws, rows, signalRows)
        await markWindowFinalized(tx, ws, stamp)
      })
      finalized++
    } catch (error) {
      log.error({ windowStart: ws, err: String(error) },
        'stable heat window malformed — leaving it unfinalized')
    }
  }
  if (finalized) log.info({ windows: finalized }, 'repaired and finalized stable heat windows')
  return finalized
}
