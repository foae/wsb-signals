/**
 * Deterministic evidence builders (P3, plays-plan §5; product §4.2) — TS + SQL, no LLM. The
 * returned `PlayEvidence` is BOTH what the interpret prompt sees and what is stored verbatim on
 * `play_interpretations.evidence` (invariant P2: every published label traces to this object).
 *
 * The load-bearing anchoring rules, verbatim from the product spec:
 *
 *  - **Radar/herd evidence anchors at the position-OPEN moment, not the post** — a Gain/Loss post
 *    documents a trade opened days or weeks earlier; post-time evidence would describe the
 *    attention state of an irrelevant moment and let the herd gate fire on chatter that POSTDATES
 *    the entry. `opened_at` (visible on most broker screens) anchors when present; post-time is
 *    the fallback and is badged as weaker evidence (`anchor_basis`).
 *  - **Last finalized window**: the newest radar window at/before the anchor with non-null
 *    `cycle_runs.finalized_at`. Publish completeness and longitudinal immutability are distinct.
 *  - **Staleness bound**: a finalized window more than `heat_staleness_hours` older than the anchor
 *    (radar outage) reads "heat evidence unavailable", never stale context served as current.
 *  - **The herd measure counts DISTINCT AUTHORS, posts only** — WSB serial-reposters would
 *    fabricate a herd out of post counts — restricted to the plays flair set, same DERIVED
 *    direction, trailing `lookback_hours` before the anchor, excluding the play's own author and
 *    its own post.
 *  - **Structural absence**: `known_non_equity`/`unvalidated` tickers never enter the
 *    whitelist-gated `mentions` table, so their radar/herd evidence is absent by construction —
 *    reported as unavailable, and `herd-following` is unassignable for them (invariant P4).
 *  - **Market evidence anchors at the POST date** (what the screenshot's P&L reflects), from daily
 *    bars — a play interpreted days after capture (budget parking) must not read today's move as
 *    the post day's.
 */
import { and, countDistinct, eq, gt, inArray, isNotNull, lt, lte, ne, sql } from 'drizzle-orm'

import { cycleRuns, empiricalFeatures, marketMovers, mentions, signals } from '@wsb/shared'

import type { Db } from '../db'
import { log } from '../logger'
import type { MarketData } from '../market'
import type { PlayDirection } from './extraction'
import type { PlayExtraction, TickerOutcome, ValidatedPosition } from './validate'

export const EVIDENCE_VERSION = 'evidence-v1'

const DAY_S = 86_400

// --- pure derivations (unit-tested; no I/O) ---------------------------------------------------------

export interface Anchor {
  utc: number
  /** `post_time` on a screenshot that showed no open date = the weaker-evidence badge (product §4.2). */
  basis: 'opened_at' | 'post_time'
}

/**
 * The evidence anchor: end of the earliest `opened_at` day (the entry happened SOMETIME that day —
 * end-of-day includes the same-day chatter that preceded it), clamped to the post time and never
 * after it. A future `opened_at` (extraction misread) is ignored rather than anchoring evidence in
 * a window that cannot contain the entry.
 */
export function deriveAnchor(positions: readonly ValidatedPosition[], postUtc: number): Anchor {
  let earliest: number | null = null
  for (const p of positions) {
    if (p.opened_at == null) continue
    const dayStart = Date.parse(`${p.opened_at}T00:00:00Z`) / 1000
    if (Number.isNaN(dayStart) || dayStart > postUtc) continue
    if (earliest == null || dayStart < earliest) earliest = dayStart
  }
  if (earliest == null) return { utc: postUtc, basis: 'post_time' }
  // −1s keeps the anchor INSIDE the opened day's last hour bucket (a flat +DAY_S is the next day's
  // midnight, which would bucket the heat lookup one window past the entry day — review 2026-08-20).
  return { utc: Math.min(earliest + DAY_S - 1, postUtc), basis: 'opened_at' }
}

/** The board's headline ticker: cost-basis-weighted dominant ticker (a $10k position outranks a $50
 *  hedge), falling back to leg count when no leg carries a basis; ties break by first appearance
 *  (screen order — the first leg is nearly always what the post is about). */
export function derivePrimaryTicker(positions: readonly ValidatedPosition[]): string | null {
  if (positions.length === 0) return null
  const weight = new Map<string, number>()
  const legs = new Map<string, number>()
  const order: string[] = []
  for (const p of positions) {
    if (!weight.has(p.ticker)) order.push(p.ticker)
    weight.set(p.ticker, (weight.get(p.ticker) ?? 0) + (p.cost_basis ?? 0))
    legs.set(p.ticker, (legs.get(p.ticker) ?? 0) + 1)
  }
  const anyWeight = [...weight.values()].some((w) => w > 0)
  const score = anyWeight ? weight : legs
  let best = order[0]!
  for (const t of order) if (score.get(t)! > score.get(best)!) best = t
  return best
}

/**
 * The POSTED play-level P&L (what the screenshot showed — plan §5's board semantics; P5 marks never
 * overwrite it). Absolute: the sum over legs that report one. Percent: aggregate over the legs that
 * carry BOTH pnl_abs and cost_basis (Σpnl/Σbasis — per-leg percents don't sum); when no leg has
 * that pair but exactly one leg reports a percent, that percent IS the play's. Nulls mean the
 * screenshot didn't say — never computed from thin air. **Mixed currencies never sum** (review
 * 2026-08-20: a CAD leg + a USD leg is not a dollar total — seen live on Webull screenshots);
 * null = assume USD per the schema convention.
 */
export function derivePostedPnl(
  positions: readonly ValidatedPosition[],
): { pnlAbs: number | null; pnlPct: number | null } {
  const oneCurrency = (legs: readonly ValidatedPosition[]): boolean =>
    new Set(legs.map((p) => p.currency ?? 'USD')).size <= 1
  const withAbs = positions.filter((p) => p.pnl_abs != null)
  const pnlAbs = withAbs.length && oneCurrency(withAbs)
    ? withAbs.reduce((s, p) => s + p.pnl_abs!, 0)
    : null
  const paired = positions.filter((p) => p.pnl_abs != null && p.cost_basis != null && p.cost_basis > 0)
  let pnlPct: number | null = null
  if (paired.length && oneCurrency(paired)) {
    const basis = paired.reduce((s, p) => s + p.cost_basis!, 0)
    pnlPct = (paired.reduce((s, p) => s + p.pnl_abs!, 0) / basis) * 100
  } else if (!paired.length) {
    const withPct = positions.filter((p) => p.pnl_pct != null)
    if (withPct.length === 1) pnlPct = withPct[0]!.pnl_pct
  }
  return { pnlAbs, pnlPct }
}

/** Play-level realized flag for the board: any open leg → false (still a live position — what P5
 *  tracks); all reporting legs closed → true; nothing reported → null. */
export function deriveRealized(positions: readonly ValidatedPosition[]): boolean | null {
  const known = positions.filter((p) => p.realized != null)
  if (known.length === 0) return null
  return known.every((p) => p.realized === true)
}

// --- evidence assembly (DB + market reads; one object out) ------------------------------------------

export interface RadarHeat {
  rank: number | null
  sov: number | null
  h_e: number | null
  mentions: number | null
  authors: number | null
}

export interface RadarEvidence {
  /** The last COMPLETE radar window at/before the anchor; null = none exists or it is stale. */
  window_start: number | null
  /** null = "heat evidence unavailable" (no complete window / staleness bound tripped); a present
   *  object with null fields = the window exists but the ticker was NOT on the board (no heat). */
  heat: RadarHeat | null
  mentions_24h: number
  authors_24h: number
  mentions_72h: number
  authors_72h: number
  note: string | null
}

export interface HerdEvidence {
  /** The play's derived direction mapped onto mention direction; null = neutral/hedged book —
   *  the herd measure treats that as no-match (product §4.1). */
  direction: 'bull' | 'bear' | null
  distinct_authors: number | null
  threshold: number
  lookback_hours: number
  /** THE herd gate (invariant P4): only `true` unlocks `herd-following` in the category enum. */
  eligible: boolean
}

export interface MarketEvidence {
  /** Session (daily-bar) timestamp the returns are computed at; null = no usable bars. */
  as_of: number | null
  day_ret: number | null
  five_day_ret: number | null
  rvol: number | null
  rvol_conf: 'low' | null
  /** Movers-list kinds (`active`/`gainer`/`loser`) the ticker appeared in within ±24 h of the post. */
  movers: string[]
  note: string | null
}

export interface PlayEvidence {
  evidence_version: typeof EVIDENCE_VERSION
  ticker: string | null
  ticker_outcome: TickerOutcome | null
  direction: PlayDirection
  anchor_utc: number
  anchor_basis: Anchor['basis']
  post_utc: number
  /** null = structurally absent (no ticker / non-equity / unvalidated — never in `mentions`). */
  radar: RadarEvidence | null
  herd: HerdEvidence | null
  market: MarketEvidence | null
  note: string | null
}

export interface EvidenceDeps {
  /** The DEDICATED plays pool (invariant P9) — evidence reads radar tables, but never on its pool. */
  db: Db
  /** Absent (--no-market / no creds) → market evidence unavailable, noted. */
  market?: MarketData | null
  /** The plays flair set — the herd measure is restricted to position-post flairs (product §4.2). */
  flairs: Set<string>
  herdLookbackHours: number
  herdMinAuthors: number
  heatStalenessSeconds: number
  /** The radar's window size ([window].seconds — hour buckets). */
  windowSeconds: number
}

const mapDirection = (d: PlayDirection): 'bull' | 'bear' | null =>
  d === 'bullish' ? 'bull' : d === 'bearish' ? 'bear' : null

async function mentionCounts(
  db: Db, ticker: string, fromUtc: number, toUtc: number,
): Promise<{ mentions: number; authors: number }> {
  const [row] = await db.select({
    mentions: sql<number>`count(*)::int`,
    authors: countDistinct(mentions.author),
  }).from(mentions)
    .where(and(eq(mentions.ticker, ticker), gt(mentions.createdUtc, fromUtc), lte(mentions.createdUtc, toUtc)))
  return { mentions: row?.mentions ?? 0, authors: row?.authors ?? 0 }
}

async function buildRadarEvidence(
  deps: EvidenceDeps, ticker: string, anchorUtc: number,
): Promise<RadarEvidence> {
  const anchorBucket = Math.floor(anchorUtc / deps.windowSeconds) * deps.windowSeconds

  // Explicit finalization: current W and lateness-horizon W−1 remain provisional; stable rows through W−2 qualify.
  // Raw-`sql` aggregates bypass drizzle's bigint→number mapping (pg returns bigint as a STRING).
  const [completeRow] = await deps.db.select({
    w: sql<string | null>`max(${cycleRuns.windowStart})`,
  }).from(cycleRuns).where(and(
    eq(cycleRuns.status, 'complete'),
    isNotNull(cycleRuns.finalizedAt),
    lte(cycleRuns.windowStart, anchorBucket),
  ))
  const windowStart = completeRow?.w == null ? null : Number(completeRow.w)

  const stale = windowStart == null || anchorBucket - windowStart > deps.heatStalenessSeconds
  let heat: RadarHeat | null = null
  let note: string | null = null
  if (stale) {
    note = windowStart == null
      ? 'heat evidence unavailable — no finalized radar window at/before the anchor'
      : `heat evidence unavailable — newest finalized window is ${
        Math.round((anchorBucket - windowStart) / 3600)}h older than the anchor (staleness bound)`
  } else {
    const [feat] = await deps.db.select({
      sov: empiricalFeatures.sov, hE: empiricalFeatures.hE,
      mentions: empiricalFeatures.mentions, authors: empiricalFeatures.authors,
    }).from(empiricalFeatures)
      .where(and(eq(empiricalFeatures.ticker, ticker), eq(empiricalFeatures.windowStart, windowStart)))
    const [sig] = await deps.db.select({ rank: signals.rank }).from(signals)
      .where(and(eq(signals.ticker, ticker), eq(signals.windowStart, windowStart)))
    // No feature row = the ticker simply wasn't mentioned that window — genuine "no heat", not an error.
    heat = {
      rank: sig?.rank ?? null,
      sov: feat?.sov ?? null,
      h_e: feat?.hE ?? null,
      mentions: feat?.mentions ?? null,
      authors: feat?.authors ?? null,
    }
  }

  const [t24, t72] = await Promise.all([
    mentionCounts(deps.db, ticker, anchorUtc - DAY_S, anchorUtc),
    mentionCounts(deps.db, ticker, anchorUtc - 3 * DAY_S, anchorUtc),
  ])
  return {
    window_start: stale ? null : windowStart,
    heat,
    mentions_24h: t24.mentions, authors_24h: t24.authors,
    mentions_72h: t72.mentions, authors_72h: t72.authors,
    note,
  }
}

async function buildHerdEvidence(
  deps: EvidenceDeps, ticker: string, direction: PlayDirection, anchorUtc: number,
  playId: string, playAuthor: string | null,
): Promise<HerdEvidence> {
  const mapped = mapDirection(direction)
  const base: HerdEvidence = {
    direction: mapped, distinct_authors: null,
    threshold: deps.herdMinAuthors, lookback_hours: deps.herdLookbackHours, eligible: false,
  }
  if (mapped == null) return base // neutral/hedged book: no direction to match — herd unassignable

  const conditions = [
    eq(mentions.ticker, ticker),
    eq(mentions.thingType, 'post'),
    inArray(mentions.flair, [...deps.flairs]),
    eq(mentions.direction, mapped),
    gt(mentions.createdUtc, anchorUtc - deps.herdLookbackHours * 3600),
    lte(mentions.createdUtc, anchorUtc),
    // Distinct AUTHORS, and never the play's own: null/[deleted] can't join (an unguarded match
    // would cross-link every deleted-author post), and the play's own post/author is excluded —
    // one prolific poster is not a herd (product §4.2).
    isNotNull(mentions.author),
    ne(mentions.author, '[deleted]'),
    ne(mentions.thingId, playId),
    ...(playAuthor ? [ne(mentions.author, playAuthor)] : []),
  ]
  const [row] = await deps.db.select({ authors: countDistinct(mentions.author) }).from(mentions)
    .where(and(...conditions))
  const authors = row?.authors ?? 0
  return { ...base, distinct_authors: authors, eligible: authors >= deps.herdMinAuthors }
}

async function buildMarketEvidence(
  deps: EvidenceDeps, ticker: string, postUtc: number,
): Promise<MarketEvidence> {
  const out: MarketEvidence = {
    as_of: null, day_ret: null, five_day_ret: null, rvol: null, rvol_conf: null, movers: [], note: null,
  }

  // Movers membership comes from the DB (the radar persists screeners every cycle) — available even
  // when the live market handle is not.
  const moverRows = await deps.db.selectDistinct({ kind: marketMovers.kind }).from(marketMovers)
    .where(and(
      eq(marketMovers.symbol, ticker),
      gt(marketMovers.ts, postUtc - DAY_S), lte(marketMovers.ts, postUtc + DAY_S)))
  out.movers = moverRows.map((r) => r.kind).sort()

  if (!deps.market?.dailyBars) {
    out.note = 'market data unavailable (no provider)'
    return out
  }
  try {
    // ~16 calendar days back guarantees ≥6 sessions for the 5-day return across holidays. The bar
    // that carries the returns is the last SESSION UNDERWAY at post time — see module doc. Alpaca
    // stamps a daily bar at midnight ET (~04–05 Z), hours BEFORE its session trades, so a plain
    // date filter would hand a pre-market post the coming session's move once that bar exists
    // (review 2026-08-20). The offset approximates midnight-ET → the 13:30 Z open; a post during
    // the session gets that session day-to-date (the radar's own `ret` semantics).
    const SESSION_OPEN_OFFSET_S = 9 * 3600
    const bars = await deps.market.dailyBars(ticker, postUtc - 16 * DAY_S, postUtc + DAY_S)
    const upTo = bars.filter((b) => b.ts + SESSION_OPEN_OFFSET_S <= postUtc)
    const day = upTo[upTo.length - 1]
    const prev = upTo[upTo.length - 2]
    if (day) out.as_of = day.ts
    if (day?.close != null && prev?.close) out.day_ret = (day.close - prev.close) / prev.close
    // Same convention as the radar's rvol (day volume vs prev full day); the free IEX feed is thin,
    // so the low-confidence flag carries over verbatim (product §4.2).
    if (day?.volume != null && prev?.volume) {
      out.rvol = day.volume / prev.volume
      out.rvol_conf = 'low'
    }
    const fiveBack = upTo[upTo.length - 6]
    if (day?.close != null && fiveBack?.close) out.five_day_ret = (day.close - fiveBack.close) / fiveBack.close
    if (!day) out.note = 'no daily bars around the post date'
  } catch (e) {
    // A market blip degrades evidence, it never parks the play (the radar itself continues
    // empirical-only on market failures — same posture).
    out.note = `market fetch failed: ${String(e).slice(0, 140)}`
    log.warn({ ticker, err: String(e).slice(0, 200) }, 'plays market evidence fetch failed — degrading')
  }
  return out
}

/**
 * Assemble the full evidence block for one play. Deterministic given the DB/provider state; DB
 * errors propagate (a stage crash → the queue's attempt/backoff), market errors degrade in place.
 */
export async function buildPlayEvidence(
  deps: EvidenceDeps,
  play: { id: string; author: string | null; createdUtc: number },
  extraction: PlayExtraction,
): Promise<PlayEvidence> {
  const primary = derivePrimaryTicker(extraction.positions)
  const outcome = primary == null
    ? null
    : extraction.positions.find((p) => p.ticker === primary)!.ticker_outcome
  const anchor = deriveAnchor(extraction.positions, play.createdUtc)

  if (primary == null || outcome !== 'validated') {
    // Structural absence (product §4.2): non-equity/unvalidated tickers never enter the
    // whitelist-gated mentions table — radar+herd unavailable, herd-following unassignable (P4).
    return {
      evidence_version: EVIDENCE_VERSION,
      ticker: primary, ticker_outcome: outcome, direction: extraction.direction,
      anchor_utc: anchor.utc, anchor_basis: anchor.basis, post_utc: play.createdUtc,
      radar: null, herd: null, market: null,
      note: primary == null
        ? 'no positions extracted — radar/herd/market evidence unavailable'
        : `ticker ${primary} is ${outcome} — radar/herd evidence structurally absent; herd-following unassignable`,
    }
  }

  const [radar, herd, market] = await Promise.all([
    buildRadarEvidence(deps, primary, anchor.utc),
    buildHerdEvidence(deps, primary, extraction.direction, anchor.utc, play.id, play.author),
    buildMarketEvidence(deps, primary, play.createdUtc),
  ])
  return {
    evidence_version: EVIDENCE_VERSION,
    ticker: primary, ticker_outcome: outcome, direction: extraction.direction,
    anchor_utc: anchor.utc, anchor_basis: anchor.basis, post_utc: play.createdUtc,
    radar, herd, market, note: null,
  }
}
