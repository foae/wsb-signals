/**
 * Deterministic validation pass over a raw LLM extraction (P2, product §4.1) — TS, not the LLM:
 *
 *  - **Ticker: three outcomes, never two** — `validated` (whitelist / ticker_names hit),
 *    `known_non_equity` (SPX/VIX/futures/crypto staples of exactly these flairs: absent from the
 *    Alpaca `us_equity` whitelist BY CONSTRUCTION, so treating absence as suspicion would downgrade
 *    half of r/wsb; normal confidence, flagged untrackable-by-Alpaca), and `unvalidated`
 *    (confidence downgrade). The system never silently invents a ticker (invariant P3).
 *  - **P&L arithmetic cross-check** (2 % of cost basis, $1 floor): `pnl ≈ value − cost` oriented by
 *    `side`. Failures downgrade confidence — they are NOT silently corrected (the broker screenshot
 *    is the source of truth; a mismatch means the extraction misread something).
 *  - **Published confidence is DERIVED here** — ticker outcome, arithmetic consistency, media
 *    presence; the model's self-reported number is one minor input (LLM self-confidence is poorly
 *    calibrated).
 *  - **`position_id` is assigned deterministically from leg content** (never model-invented), so a
 *    re-extraction of the same screenshot yields the same ids and P5 marks stay aligned.
 */
import {
  derivePlayDirection, EXTRACTION_SCHEMA_VERSION,
  type ExtractedPosition, type LlmExtraction, type PlayDirection,
} from './extraction'

/** Index/futures/crypto underlyings that WSB posts constantly and Alpaca's us_equity universe can
 *  never contain. Curated like the stoplist; grow it from real `unvalidated` logs, not speculation. */
export const KNOWN_NON_EQUITY = new Set([
  'SPX', 'XSP', 'NDX', 'RUT', 'VIX', 'DJX', // index options
  'ES', 'NQ', 'RTY', 'YM', 'CL', 'GC', 'MES', 'MNQ', // futures (slash-prefix is stripped by the schema)
  'BTC', 'ETH', 'SOL', 'DOGE', 'XRP', // crypto
])

export type TickerOutcome = 'validated' | 'known_non_equity' | 'unvalidated'

export interface ValidatedPosition extends ExtractedPosition {
  position_id: string
  ticker_outcome: TickerOutcome
  /** null = not enough figures to check (pnl, cost or value missing). */
  arithmetic_ok: boolean | null
}

/** The persisted extraction (`play_extractions.output`). */
export interface PlayExtraction {
  schema_version: typeof EXTRACTION_SCHEMA_VERSION
  screenshot_kind: LlmExtraction['screenshot_kind']
  broker: string | null
  positions: ValidatedPosition[]
  notes: string | null
  direction: PlayDirection
  /** The derived, published confidence (0–1). */
  confidence: number
  /** The model's self-reported overall confidence, kept for calibration analysis. */
  model_confidence: number | null
}

export interface ValidateContext {
  /** Whitelist / ticker_names membership (the radar's universe). */
  isListedTicker: (ticker: string) => boolean
  /** The play's media made it to disk — text-only extractions carry less evidence. */
  mediaArchived: boolean
}

/** Deterministic, content-derived leg id: identical re-extractions → identical ids (P5 marks key on
 *  this). Identical legs (same ticker/instrument/side/strike/expiry) get ordinal suffixes. */
export function assignPositionIds(positions: readonly ExtractedPosition[]): ValidatedPosition['position_id'][] {
  const seen = new Map<string, number>()
  return positions.map((p) => {
    const base = [p.ticker, p.instrument, p.side, p.strike ?? 'ns', p.expiry ?? 'ne']
      .join(':').toLowerCase().replace(/[^a-z0-9:.-]/g, '')
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return n === 1 ? base : `${base}:${n}`
  })
}

export function tickerOutcome(ticker: string, isListed: (t: string) => boolean): TickerOutcome {
  if (isListed(ticker)) return 'validated'
  if (KNOWN_NON_EQUITY.has(ticker)) return 'known_non_equity'
  return 'unvalidated'
}

/** `pnl ≈ value − cost` oriented by side, within max(2 % of cost basis, $1). null = unverifiable. */
export function arithmeticOk(p: ExtractedPosition): boolean | null {
  if (p.pnl_abs == null || p.cost_basis == null || p.current_value == null) return null
  const expected = p.side === 'long' ? p.current_value - p.cost_basis : p.cost_basis - p.current_value
  const tolerance = Math.max(0.02 * p.cost_basis, 1)
  return Math.abs(p.pnl_abs - expected) <= tolerance
}

/**
 * Derived confidence — the exact formula is deliberately simple and documented so an agent reading
 * a published number can reproduce it:
 *   base 0.9 (all tickers validated / known-non-equity) or 0.5 (any unvalidated)
 *   − 0.15 per arithmetic-failing leg (floor 0.1)
 *   × 0.8 when the play has no archived media (text-only evidence)
 *   then blended 3:1 with the model's self-report when present.
 */
export function deriveConfidence(
  positions: readonly ValidatedPosition[], ctx: ValidateContext, modelConfidence: number | null,
): number {
  const anyUnvalidated = positions.some((p) => p.ticker_outcome === 'unvalidated')
  let c = positions.length === 0 ? 0.3 : anyUnvalidated ? 0.5 : 0.9
  const arithmeticFailures = positions.filter((p) => p.arithmetic_ok === false).length
  c = Math.max(0.1, c - 0.15 * arithmeticFailures)
  if (!ctx.mediaArchived) c *= 0.8
  if (modelConfidence != null) c = 0.75 * c + 0.25 * modelConfidence
  return Math.round(c * 100) / 100
}

/** The full pass: LLM output → persisted `PlayExtraction`. Pure and total — never throws. */
export function validateExtraction(llm: LlmExtraction, ctx: ValidateContext): PlayExtraction {
  const ids = assignPositionIds(llm.positions)
  const positions: ValidatedPosition[] = llm.positions.map((p, i) => ({
    ...p,
    position_id: ids[i]!,
    ticker_outcome: tickerOutcome(p.ticker, ctx.isListedTicker),
    arithmetic_ok: arithmeticOk(p),
  }))
  return {
    schema_version: EXTRACTION_SCHEMA_VERSION,
    screenshot_kind: llm.screenshot_kind,
    broker: llm.broker,
    positions,
    notes: llm.notes,
    direction: derivePlayDirection(llm.positions),
    confidence: deriveConfidence(positions, ctx, llm.confidence),
    model_confidence: llm.confidence,
  }
}
