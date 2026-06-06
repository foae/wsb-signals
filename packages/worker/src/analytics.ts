/**
 * Attention × Action signals (signal-framework §6) — the v0.0.2 product layer. **NEW in v2: there is NO
 * Python oracle for this slice** (the frozen v0.0.1 radar creates the `signals` table but never populates
 * it — divergence/quadrants/lead-lag are explicitly Phase 3). So this module is gated by its own unit
 * tests, not by the parity fixtures. The math is deliberately simple and deterministic.
 *
 * Pure functions only (no DB, no clock). The orchestration that feeds these from Postgres lives in
 * `pipeline.buildSignals`; the DB reads live in `db.ts`.
 *
 * Semantics fixed for v2 (design decisions, recorded in design/v2-porting-spec.md §11):
 *  - **divergence = H_e − H_m** (signed): large +ve = chatter ahead of market (HYPE); large −ve = market
 *    ahead of chatter (STEALTH). Only defined where BOTH signals exist (the overlaid top-N subset).
 *  - **Quadrant split = GLOBAL rolling median** of H_e and of H_m over a trailing window of *overlaid*
 *    cells (cells that have both signals). One threshold line per signal, shared by every ticker that
 *    cycle, recomputed each cycle so it adapts ("rolling"). "Hot" = STRICTLY above the median.
 *  - **Lead-lag** = the integer-window lag maximizing the normalized cross-correlation of H_e(t) vs
 *    H_m(t); k>0 ⇒ WSB attention LEADS market action. Reported in hours, or null when no lag clears the
 *    minimum-overlap / minimum-correlation guards (the radar reports association, never prediction — §6.2).
 *  - Screener-movers ∖ WSB-hot STEALTH discovery is OUT of scope here (those tickers have no H_e, so they
 *    can't be (ticker, H_e, H_m) rows); it stays captured in `market_movers` for a later query/web surface.
 */

/** The four divergence quadrants (signal-framework §6.1). */
export type Quadrant = 'CONFIRMED' | 'HYPE' | 'STEALTH' | 'QUIET'

export interface LeadLagConfig {
  /**
   * Lead-lag is DISABLED by default (persists null). It correlates H_e(t) — a true per-window signal —
   * against H_m(t), which is **day-to-date, NOT window-aligned** (`analytical.compute_analytical`:
   * ret/rvol share the day's denominator). Intraday H_m is therefore a near-daily accumulation ramp, so
   * an hourly cross-correlation measures that ramp, not a real lead-lag (all four M3 reviewers, unanimous
   * HIGH — see porting-spec §11). Flip on only once H_m is window-aligned (intraday bars land — the
   * architecture §5 caveat). The math below still applies the small-sample guard for when it IS enabled.
   */
  enabled: boolean
  /** Trailing span (seconds) of H_e(t)/H_m(t) history to correlate. */
  lookbackSeconds: number
  /** Search lags in [-maxLagWindows, +maxLagWindows] windows. */
  maxLagWindows: number
  /** Minimum overlapping (H_e, H_m) point-pairs required at a lag for it to be considered. */
  minPairs: number
  /** Minimum-correlation FLOOR (the effective bar is `max(minCorr, ~2/√pairs)` — see leadLagHours). */
  minCorr: number
}

export interface SignalsConfig {
  /** Trailing span (seconds) of cells feeding the global rolling-median quadrant split. */
  medianLookbackSeconds: number
  /** Minimum population on the limiting (overlaid) axis before a quadrant is assigned (else null) — keeps
   *  a 1–2-cell cold-start population from producing degenerate / flip-flopping quadrants. */
  minQuadrantPopulation: number
  leadLag: LeadLagConfig
}

/** ≈ the |r| significant at p<0.05 two-sided is ~2/√n for moderate n; used as a sample-size-scaled floor. */
const SIG_Z = 2

/** A per-window point on one ticker's series; `hE`/`hM` are null for windows where the ticker was
 *  absent from the board / not overlaid (a gap on that axis). */
export interface SeriesPoint {
  windowStart: number
  hE: number | null
  hM: number | null
}

/** Median of a value list (mean of the two middles for even length); null on empty. */
export function median(values: readonly number[]): number | null {
  const n = values.length
  if (n === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = n >> 1
  return n % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

/** Signed divergence (signal-framework §6.1): +ve = WSB chatter hotter than market action. */
export function divergence(hE: number, hM: number): number {
  return hE - hM
}

/**
 * Quadrant from the global median split (§6.1). "Hot" = STRICTLY above the rolling-median threshold — a
 * value sitting exactly on the median is the quiet side (it must clear the bar to count as hot).
 */
export function classifyQuadrant(hE: number, hM: number, thrHe: number, thrHm: number): Quadrant {
  const heHot = hE > thrHe
  const hmHot = hM > thrHm
  if (heHot) return hmHot ? 'CONFIRMED' : 'HYPE'
  return hmHot ? 'STEALTH' : 'QUIET'
}

/** Pearson correlation of two equal-length samples; null if <2 points or either side is constant. */
export function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length
  if (n < 2 || ys.length !== n) return null
  let sx = 0
  let sy = 0
  for (let i = 0; i < n; i++) {
    sx += xs[i]!
    sy += ys[i]!
  }
  const mx = sx / n
  const my = sy / n
  let sxx = 0
  let syy = 0
  let sxy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx
    const dy = ys[i]! - my
    sxx += dx * dx
    syy += dy * dy
    sxy += dx * dy
  }
  if (sxx <= PEARSON_EPS || syy <= PEARSON_EPS) return null // (near-)constant series → no correlation
  return sxy / Math.sqrt(sxx * syy)
}

/** Treat a near-zero sum-of-squares as constant — guards a float-noise denominator underflowing to NaN. */
const PEARSON_EPS = 1e-12

/**
 * Lead-lag in HOURS (signal-framework §6.2). Places the series on a regular window grid (so gaps are
 * handled — a missing window is simply an absent index), then for each integer lag k in
 * [-maxLagWindows, +maxLagWindows] correlates H_e(t) with H_m(t+k). The lag with the highest correlation
 * is the lead-lag: **k>0 ⇒ H_e (WSB attention) leads H_m (market) by k windows**. Ties prefer the
 * smaller |lag| (the more conservative claim). Returns `k·windowSeconds/3600`, or null.
 *
 * Two guards keep this from reporting noise (M3 review, unanimous HIGH — porting-spec §11): a lag needs
 * ≥ `minPairs` overlapping pairs, AND the peak correlation must clear a **sample-size-scaled bar**
 * `max(minCorr, SIG_Z/√pairs)` — so with few overlapping points (the radar is days old) a much higher r
 * is required, roughly the p<0.05 significance level, partly offsetting the 13-lag multiple-comparison
 * search. NOTE this is necessary but NOT sufficient: it does NOT fix the day-to-date-vs-window-aligned
 * H_m mismatch (that's why lead-lag is disabled by default; see `LeadLagConfig.enabled`).
 */
export function leadLagHours(
  series: readonly SeriesPoint[],
  windowSeconds: number,
  cfg: LeadLagConfig,
): number | null {
  if (series.length === 0) return null
  const base = series.reduce((mn, p) => (p.windowStart < mn ? p.windowStart : mn), series[0]!.windowStart)
  const idxOf = (ws: number): number => Math.round((ws - base) / windowSeconds)
  const eByIdx = new Map<number, number>()
  const mByIdx = new Map<number, number>()
  for (const p of series) {
    const idx = idxOf(p.windowStart)
    if (p.hE != null) eByIdx.set(idx, p.hE)
    if (p.hM != null) mByIdx.set(idx, p.hM)
  }

  let bestCorr = Number.NEGATIVE_INFINITY
  let bestLag: number | null = null
  let bestPairs = 0
  for (let lag = -cfg.maxLagWindows; lag <= cfg.maxLagWindows; lag++) {
    const xs: number[] = []
    const ys: number[] = []
    for (const [idx, e] of eByIdx) {
      const m = mByIdx.get(idx + lag)
      if (m !== undefined) {
        xs.push(e)
        ys.push(m)
      }
    }
    if (xs.length < cfg.minPairs) continue
    const c = pearson(xs, ys)
    if (c == null) continue
    if (c > bestCorr || (c === bestCorr && bestLag != null && Math.abs(lag) < Math.abs(bestLag))) {
      bestCorr = c
      bestLag = lag
      bestPairs = xs.length
    }
  }
  if (bestLag == null) return null
  const bar = Math.max(cfg.minCorr, SIG_Z / Math.sqrt(bestPairs)) // sample-size-scaled significance floor
  if (bestCorr < bar) return null
  return (bestLag * windowSeconds) / 3600
}
