/**
 * `markPlay` — the P2↔P5 pin (plays-plan §4): pure mark-to-market math over the pinned extraction
 * schema. P2 lands the function + unit tests so the schema is PROVEN to carry everything outcome
 * tracking needs; P5 adds the quote plumbing (trading calendar, option snapshots) and the daily
 * pass that persists `play_marks` rows. Nothing else forces the pin to hold across three slices.
 *
 * Conventions (all pinned by the schema, `extraction.ts`, and asserted by the unit tests):
 *  - quantity is positive; `side` orients the P&L: long P&L = value − cost, short P&L = credit −
 *    cost-to-close. No signed quantities anywhere.
 *  - option quotes are PER-SHARE; the ×100 contract multiplier is applied exactly once, here.
 *  - `cost_basis`/`current_value`/quotes are absolute dollars; only P&L is signed.
 *  - per-POSITION marks (schema `play_marks` keys on `(play_id, position_id, ts)`); play-level
 *    P&L is the sum over marked positions — and stays per-post downstream (invariant P5: never
 *    aggregate to per-ticker win rates).
 */
import type { ExtractedPosition } from './extraction'

/** A leg as marked: the extraction fields plus the deterministic id `validate.ts` assigned. */
export type MarkablePosition = ExtractedPosition & { position_id: string }

/** Per-share mark for a leg (stock last/mid, or option mid) — P5 supplies these from MarketData. */
export interface PositionQuote {
  price: number
}

export interface PositionMark {
  positionId: string
  markable: boolean
  /** Why not, when !markable: 'realized' | 'other-instrument' | 'non-usd' | 'no-quote' | 'no-cost-basis'. */
  reason: string | null
  /** Absolute dollars at the quote: liquidation value (long) / cost to close (short). */
  markValue: number | null
  /** Signed P&L vs cost basis. */
  pnlAbs: number | null
  pnlPct: number | null
}

export interface PlayMarkResult {
  positions: PositionMark[]
  /** Sum over MARKED positions only; null when nothing was markable. */
  totalPnlAbs: number | null
  totalCostBasis: number | null
  markedCount: number
  unmarkedCount: number
}

/** Contract multiplier: options settle ×100 per contract; shares are 1:1. `other` is unmarkable —
 *  its payoff shape is unknown, and guessing a multiplier is the 100× landmine this pin exists for. */
export function multiplierFor(instrument: ExtractedPosition['instrument']): number | null {
  if (instrument === 'call' || instrument === 'put') return 100
  if (instrument === 'shares') return 1
  return null
}

function markPosition(p: MarkablePosition, quote: PositionQuote | undefined): PositionMark {
  const base = { positionId: p.position_id, markValue: null, pnlAbs: null, pnlPct: null }
  // Realized legs are closed: the broker-reported P&L is final, marking would be fiction.
  if (p.realized === true) return { ...base, markable: false, reason: 'realized' }
  const mult = multiplierFor(p.instrument)
  if (mult == null) return { ...base, markable: false, reason: 'other-instrument' }
  // Non-USD positions are untrackable in v1 — marking them against US quotes would be silently wrong.
  if (p.currency != null && p.currency !== 'USD') return { ...base, markable: false, reason: 'non-usd' }
  if (quote == null || !Number.isFinite(quote.price) || quote.price < 0) {
    return { ...base, markable: false, reason: 'no-quote' }
  }
  if (p.cost_basis == null) return { ...base, markable: false, reason: 'no-cost-basis' }

  const markValue = p.quantity * quote.price * mult
  const pnlAbs = p.side === 'long' ? markValue - p.cost_basis : p.cost_basis - markValue
  const pnlPct = p.cost_basis > 0 ? (pnlAbs / p.cost_basis) * 100 : null
  return { positionId: p.position_id, markable: true, reason: null, markValue, pnlAbs, pnlPct }
}

/** Mark every position of a play against per-position quotes (keyed by `position_id`). Pure. */
export function markPlay(
  positions: readonly MarkablePosition[], quotes: Readonly<Record<string, PositionQuote>>,
): PlayMarkResult {
  const marks = positions.map((p) => markPosition(p, quotes[p.position_id]))
  const marked = marks.filter((m) => m.markable)
  const totalPnlAbs = marked.length ? marked.reduce((s, m) => s + m.pnlAbs!, 0) : null
  const totalCostBasis = marked.length
    ? positions.filter((p) => marks.find((m) => m.positionId === p.position_id)?.markable)
      .reduce((s, p) => s + (p.cost_basis ?? 0), 0)
    : null
  return {
    positions: marks,
    totalPnlAbs,
    totalCostBasis,
    markedCount: marked.length,
    unmarkedCount: marks.length - marked.length,
  }
}
