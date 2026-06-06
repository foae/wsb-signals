/**
 * Windowed aggregator — TS port of the frozen v0.0.1 `wsb_signals/aggregate.py` (signal-framework
 * §2–§5). Turns the window's mentions into per-(ticker, window) empirical features + the composite
 * WSB Heat `H_e`. SoV-primary: `z` is computed but kept off the blend until its hour-of-week baseline
 * is `ready` (weight stays 0). Components are max-normalized (NOT percentile-ranked) within the window.
 *
 * Pure function: the Python original reads four things from DuckDB
 * (`mentions_in_window` / `features_at` / `sov_ranks_at` / `feature_history`); here those are explicit
 * inputs (captured in the golden fixtures), so the port is DB-free and diffs at the object boundary
 * (v2-porting-spec.md §1–§2). Gated on fixtures/aggregate/*.json — values AND order.
 *
 * Cross-language landmines handled:
 *  - `hourOfWeek` weekday remap: Python tm_wday (Mon=0) vs JS getUTCDay (Sun=0) → `((d+6)%7)*24+h`;
 *  - two-pass sample variance ÷ (n−1);
 *  - null `velocity`/`accel` propagation (no prior window vs. no prior velocity);
 *  - the blend is evaluated in the SAME operation order as Python so equal-input H_e is bit-identical,
 *    making the canonical tie-break (h_e→sov→authors→mentions→ticker) reproduce the oracle's order.
 *
 * NOTE (scope): `write_snapshot`/`pretty_name` are NOT ported here. The leaderboard.json snapshot is a
 * v0.0.1 presentation/locking workaround; in v2 the "publish" is a Postgres write + a freshness marker
 * (slice 3), and row rounding/pretty-names belong with the reader. `flairCounts` is an object (→ JSONB),
 * not Python's sorted json STRING — parity is on the COUNTS, not the serialization.
 */

/** A mention row as captured from `db.mentions_in_window`: [ticker, thingId, thingType, author, flair, direction]. */
export type MentionRow = readonly [
  ticker: string,
  thingId: string,
  thingType: string | null,
  author: string | null,
  flair: string | null,
  direction: string | null,
]

/** Prior-window features by ticker (from `features_at`): supplies mentions(W−1) + velocity(W−1). */
export type PriorFeatures = Record<string, { mentions: number | null; velocity: number | null }>

/** Per-(ticker, window, mentions) history rows (from `feature_history`): [ticker, windowStart, mentions]. */
export type HistoryRow = readonly [ticker: string, windowStart: number, mentions: number]

export interface HeatWeights {
  sov: number
  accel: number
  rank_delta: number
  authors: number
  conviction: number
  net_dir: number
  z: number
}

export interface AggregateInputs {
  windowStart: number
  windowSeconds: number
  weights: HeatWeights
  minSamplesReady: number
  minAuthorsFull: number
  mentionsInWindow: readonly MentionRow[]
  priorFeatures: PriorFeatures
  priorSovRanks: Record<string, number>
  featureHistory: readonly HistoryRow[]
}

export type BaselineStatus = 'cold' | 'warming' | 'ready'

/** A (ticker, window) empirical cell — the live empirical signal (mirrors `models.EmpiricalFeature`). */
export interface EmpiricalFeature {
  ticker: string
  windowStart: number
  mentions: number
  authors: number
  sov: number
  velocity: number | null
  accel: number | null
  z: number | null
  netDir: number
  ddCount: number
  flairCounts: Record<string, number> // {flair: count} — → JSONB (was a json string in DuckDB)
  baselineStatus: BaselineStatus
  hE: number
}

/** 0..167 — Monday 00:00 UTC = 0. JS `getUTCDay()` is Sun=0, so remap to Python's Mon=0 `tm_wday`. */
export function hourOfWeek(epoch: number): number {
  const d = new Date(epoch * 1000)
  const weekday = (d.getUTCDay() + 6) % 7 // Sun(0)→6, Mon(1)→0, … Sat(6)→5
  return weekday * 24 + d.getUTCHours()
}

/** Clock-aligned tumbling window containing `now`. */
export function windowStartFor(now: number, windowSeconds: number): number {
  return Math.floor(now / windowSeconds) * windowSeconds
}

/**
 * Scale to [0,1] by the window max (negatives floored to 0); all-zero or empty → zeros.
 * Max-norm — NOT percentile rank — keeps H_e SoV-primary (see aggregate.py `_max_norm` docstring).
 */
export function maxNorm(values: readonly number[]): number[] {
  const vmax = values.reduce((mx, v) => (v > mx ? v : mx), Number.NEGATIVE_INFINITY)
  if (values.length === 0 || vmax <= 0) return values.map(() => 0)
  return values.map((v) => Math.max(0, v) / vmax)
}

interface Feat {
  ticker: string
  mentions: number
  authors: number
  sov: number
  velocity: number | null
  accel: number | null
  netDir: number
  ddCount: number
  flairCounts: Record<string, number>
  z: number | null
  baselineStatus: BaselineStatus
  rankDelta: number
}

interface Bucket {
  things: Set<string>
  authors: Set<string>
  bull: number
  bear: number
  dd: Set<string>
  flairs: Map<string, number>
}

export function aggregateWindow(inp: AggregateInputs): EmpiricalFeature[] {
  const { windowStart, weights: w, minSamplesReady, minAuthorsFull } = inp
  if (inp.mentionsInWindow.length === 0) return []

  // group by ticker, dedup things by thingId (one mention per (ticker, thing) — §2.1 grain)
  const per = new Map<string, Bucket>()
  for (const [ticker, thingId, thingType, author, flair, direction] of inp.mentionsInWindow) {
    let d = per.get(ticker)
    if (!d) {
      d = { things: new Set(), authors: new Set(), bull: 0, bear: 0, dd: new Set(), flairs: new Map() }
      per.set(ticker, d)
    }
    if (d.things.has(thingId)) continue
    d.things.add(thingId)
    if (author) d.authors.add(author)
    if (direction === 'bull') d.bull++
    else if (direction === 'bear') d.bear++
    if (flair) {
      d.flairs.set(flair, (d.flairs.get(flair) ?? 0) + 1)
      if (thingType === 'post' && flair.trim().toUpperCase() === 'DD') d.dd.add(thingId)
    }
  }

  let total = 0
  for (const d of per.values()) total += d.things.size
  total = total || 1

  const priorExists = Object.keys(inp.priorFeatures).length > 0 // was W−1 aggregated at all?

  // baselines: prior windows in the same hour-of-week bucket (forward-only)
  const how = hourOfWeek(windowStart)
  const base = new Map<string, number[]>()
  for (const [tk, ws, m] of inp.featureHistory) {
    if (hourOfWeek(ws) === how) {
      const arr = base.get(tk)
      if (arr) arr.push(m)
      else base.set(tk, [m])
    }
  }

  // first pass — raw features per ticker
  const feats: Feat[] = []
  for (const [t, d] of per) {
    const m = d.things.size
    let velocity: number | null
    let accel: number | null
    if (priorExists) {
      // W−1 was aggregated, so a ticker absent from it genuinely had 0 mentions then.
      const pf = inp.priorFeatures[t]
      const pm = (pf?.mentions ?? 0) || 0 // Python `... or 0` — null/0 → 0
      velocity = m - pm
      const pv = pf?.velocity // accel needs W−1's stored velocity, else undefined
      accel = pv != null ? velocity - pv : null
    } else {
      // No prior window at all (cold start / gap): momentum is UNDEFINED — emitting 0-based deltas
      // would make every ticker look like a fresh breakout and inflate H_e.
      velocity = null
      accel = null
    }
    const bull = d.bull
    const bear = d.bear
    const netDir = bull + bear ? (bull - bear) / (bull + bear) : 0

    const samples = base.get(t) ?? []
    let status: BaselineStatus = 'cold'
    let z: number | null = null
    // max(2, …): sample variance divides by (n−1), so a misconfigured min_samples_ready=1 would
    // divide by zero — never treat a single sample as `ready`.
    if (samples.length >= Math.max(2, minSamplesReady)) {
      status = 'ready'
      const mean = samples.reduce((s, x) => s + x, 0) / samples.length
      // `(x-mean)*(x-mean)` not `**2`: explicit multiply is the correctly-rounded square in every engine,
      // bit-matching Python's `(x-mean) ** 2`; `Math.pow(_, 2)` is not guaranteed identical across engines.
      const variance = samples.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (samples.length - 1)
      const sd = Math.sqrt(variance)
      z = sd > 0 ? (m - mean) / sd : null
    } else if (samples.length > 0) {
      status = 'warming'
    }

    feats.push({
      ticker: t,
      mentions: m,
      authors: d.authors.size,
      sov: m / total,
      velocity,
      accel,
      netDir,
      ddCount: d.dd.size,
      // sorted keys — matches Python `json.dumps(..., sort_keys=True)`; harmless for JSONB equality but
      // keeps a canonical key order if anything later stringifies it for hashing/diffing.
      flairCounts: Object.fromEntries([...d.flairs].sort((a, b) => cmpStr(a[0], b[0]))),
      z,
      baselineStatus: status,
      rankDelta: 0,
    })
  }

  // rank_delta: prior rank − current rank (+ve = climbing). Tie-break equal-SoV by ticker so rank is
  // deterministic, not dependent on iteration order.
  const ranked = [...feats].sort((a, b) => b.sov - a.sov || cmpStr(a.ticker, b.ticker))
  const curRank = new Map<string, number>()
  ranked.forEach((f, i) => curRank.set(f.ticker, i + 1))
  for (const f of feats) {
    const pr = inp.priorSovRanks[f.ticker]
    f.rankDelta = pr ? pr - curRank.get(f.ticker)! : 0 // Python `if pr` — ranks are ≥1; absent → 0
  }

  // normalize components to [0,1] by window max, then weighted blend → H_e (SoV-primary)
  const sovN = maxNorm(feats.map((f) => f.sov))
  const accN = maxNorm(feats.map((f) => (f.accel != null ? f.accel : 0))) // None/neg → 0
  const rdN = maxNorm(feats.map((f) => f.rankDelta))
  const auN = maxNorm(feats.map((f) => f.authors))
  const ddN = maxNorm(feats.map((f) => f.ddCount))
  const zN = maxNorm(feats.map((f) => (f.z != null ? f.z : 0)))

  const out: EmpiricalFeature[] = feats.map((f, i) => {
    const zReady = f.baselineStatus === 'ready' && f.z != null
    let hE =
      w.sov * sovN[i]! +
      w.accel * accN[i]! +
      w.rank_delta * rdN[i]! +
      w.authors * auN[i]! +
      w.conviction * ddN[i]! +
      w.net_dir * Math.abs(f.netDir) +
      (zReady ? w.z * zN[i]! : 0)
    // Support shrink: damp absolute H_e toward 0 until `minAuthorsFull` distinct authors back the row,
    // so a lone mention (every max-normed component = 1.0 in a quiet window) can't top the board.
    if (minAuthorsFull > 0) hE *= Math.min(1, f.authors / minAuthorsFull)
    return {
      ticker: f.ticker,
      windowStart,
      mentions: f.mentions,
      authors: f.authors,
      sov: f.sov,
      velocity: f.velocity,
      accel: f.accel,
      z: f.z,
      netDir: f.netDir,
      ddCount: f.ddCount,
      flairCounts: f.flairCounts,
      baselineStatus: f.baselineStatus,
      hE,
    }
  })

  // Canonical board order: H_e-primary, explicit total-order tie-break down to `ticker` so equal-H_e
  // rows have ONE deterministic ordering (must not depend on iteration order). h_e→sov→authors→mentions→ticker.
  //
  // RAW float compare — NOT quantized. The port is bit-exact to the oracle (same IEEE ops, same order),
  // so equal rows compare equal and genuinely-different rows compare like Python's raw sort — including
  // when the oracle's order rests on a 1-ULP h_e difference (e.g. 0.4 vs 0.39999999999999997). Quantizing
  // to 1e-9 (porting-spec §2.6, original) DISCARDS that real signal and inverts such pairs vs the oracle —
  // the random/010 fixture proved it. Near-tie robustness belongs in the slice-9 shadow-diff tolerance,
  // not in the production sort. (Spec §2.6 corrected to match.)
  out.sort(compareBoard)
  return out
}

/** A row carrying the canonical-sort keys — the structural shape `compareBoard` orders on. */
export type BoardRow = Pick<EmpiricalFeature, 'hE' | 'sov' | 'authors' | 'mentions' | 'ticker'>

/**
 * The canonical leaderboard total order — `h_e→sov→authors→mentions→ticker`, on RAW floats (see the
 * call-site note above). Exported so the rank/rank_delta reads (db.readHeRanksAt) order identically to
 * `aggregateWindow`'s board — one definition, no drift between the live board and the persisted ranks.
 */
export function compareBoard(a: BoardRow, b: BoardRow): number {
  return b.hE - a.hE || b.sov - a.sov || b.authors - a.authors || b.mentions - a.mentions || cmpStr(a.ticker, b.ticker)
}

/** Ascending string compare matching Python's `<` on str (code-point order for the ASCII tickers here). */
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
