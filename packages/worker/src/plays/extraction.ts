/**
 * The pinned `PlayExtraction` schema (P2, plays-plan §4; shape per product §4.1).
 *
 * This shape is PINNED against P5's marking math before any paid extraction runs — a weaker schema
 * would force a paid re-run of the whole backlog when outcome tracking lands. The load-bearing
 * conventions, each of which is a real money-math landmine:
 *
 *  - **One entry per leg** — a spread is N positions, never one row (marking a debit spread as its
 *    long leg alone reports unbounded phantom gains).
 *  - **`quantity` is always positive; `side` carries the sign** — a double-negative in spread-sum
 *    math is the same class of landmine as the multiplier.
 *  - **`side` (long|short) is distinct from bull/bear direction** — direction is DERIVED by
 *    `derivePlayDirection`, never asked of the model (a sold put is short AND bullish; conflating
 *    them inverts P&L on a very common WSB position).
 *  - **Option prices are per-share**; the ×100 contract multiplier is applied only in downstream
 *    math (`marking.ts`) — pinning the convention here is what keeps marks from being off by
 *    exactly 100×.
 *  - **`expiry` is a FULL date** (`YYYY-MM-DD`) or null — screenshots show "1/17"; the extractor
 *    resolves the year or leaves it null (OCC symbols need `YYMMDD`, so a partial date is useless).
 *  - **`cost_basis` and `current_value` are absolute (unsigned) dollars** — for a long leg,
 *    dollars paid / current liquidation value; for a short leg, credit received / cost to close.
 *    `side` supplies the P&L orientation (see `marking.ts`).
 *  - **Everything optional is `.nullable()`, never `.optional()`** — OpenAI strict structured
 *    outputs reject optional fields; every key is always present `[verified at P2 install]`.
 *
 * `position_id` is deliberately NOT part of the model output: the validation pass derives it
 * deterministically from leg content (`validate.ts`) so re-extractions keep marks aligned.
 */
import { z } from 'zod'

/** Bump when the schema shape changes; stored per run in `play_extractions.prompt_version` together
 *  with the prompt version, so any historical output row names the contract it satisfied. */
export const EXTRACTION_SCHEMA_VERSION = 'extract-schema-v1'

export const SCREENSHOT_KINDS = ['single_position', 'portfolio', 'order_ticket', 'chart', 'none'] as const
export const INSTRUMENTS = ['shares', 'call', 'put', 'other'] as const
export const SIDES = ['long', 'short'] as const

/** A REAL `YYYY-MM-DD` calendar date — the regex alone would admit 2026-02-31, and a phantom date
 *  poisons OCC symbol construction and expiry math downstream. */
export function isRealIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  // Plausibility clamp: a model emitted year 8170 live (2026-08-19) — a "real" calendar date the
  // pure calendar check waves through. No broker screenshot ever shows a date outside this window.
  const year = Number(s.slice(0, 4))
  if (year < 2000 || year > 2099) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** The `.regex()` (not just the refine) matters: it emits `pattern` into the wire JSON schema —
 *  the only machine-enforced format signal the model gets (a luna extraction failed on a malformed
 *  `opened_at` when the schema carried no pattern — live, 2026-08-19). */
const isoDate = (): z.ZodType<string> =>
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealIsoDate, 'not a real YYYY-MM-DD date')

/** Free-text length pins — shared by the schema and the pre-parse repair (which truncates instead
 *  of failing). NOTE: on the live codex path the model never sees these — `strictifyJsonSchema`
 *  strips `maxLength` (with the other constraint keywords) from the wire schema, so the pins are
 *  enforced only at parse time and the truncation repair is the ONLY thing standing between a
 *  chatty model and a burned extraction (review 2026-08-20). */
export const BROKER_MAX_LEN = 40
export const NOTES_MAX_LEN = 500

/**
 * Deterministic repair for model output that would fail the pinned schema on a NON-marking field,
 * applied BEFORE schema parse — none of these may kill the whole extraction:
 *  - phantom calendar dates (`2026-02-30`, seen live — strict mode enforces the pattern, not the
 *    calendar) → null; null = unknown strictly beats both a phantom date and a burned play, and
 *    the incomplete-leg confidence penalty already prices the null;
 *  - non-ISO-4217 currency strings ("USDC" on a Hyperliquid perp, live 2026-08-19) → null;
 *  - overlong free-text (`notes`/`broker`) → truncated, not nulled — a chatty `notes` burned a
 *    play live (1vsmryk, 2026-08-19: four attempts, all "expected string to have <=500 chars").
 * Everything marking-critical still hard-fails. Returns the repaired value + what was repaired
 * (for the caller's log line).
 */
export function sanitizeRawExtraction(raw: unknown): { value: unknown; repaired: string[] } {
  if (raw == null || typeof raw !== 'object') return { value: raw, repaired: [] }
  const obj = { ...(raw as Record<string, unknown>) }
  const repaired: string[] = []
  for (const [k, max] of [['notes', NOTES_MAX_LEN], ['broker', BROKER_MAX_LEN]] as const) {
    if (typeof obj[k] === 'string' && (obj[k] as string).length > max) {
      repaired.push(`${k}: truncated ${(obj[k] as string).length}→${max} chars`)
      obj[k] = (obj[k] as string).slice(0, max)
    }
  }
  if (!Array.isArray(obj.positions)) return { value: obj, repaired }
  const positions = obj.positions.map((p, i) => {
    if (p == null || typeof p !== 'object') return p
    const pos = { ...(p as Record<string, unknown>) }
    for (const k of ['expiry', 'opened_at'] as const) {
      if (typeof pos[k] === 'string' && !isRealIsoDate(pos[k] as string)) {
        repaired.push(`positions[${i}].${k}=${JSON.stringify(pos[k])}`)
        pos[k] = null
      }
    }
    if (typeof pos.currency === 'string' && !/^[A-Za-z]{3}$/.test(pos.currency)) {
      repaired.push(`positions[${i}].currency=${JSON.stringify(pos.currency)}`)
      pos.currency = null
    }
    return pos
  })
  return { value: { ...obj, positions }, repaired }
}

const confidence = (): z.ZodNumber => z.number().min(0).max(1)

/** Model self-confidence for the marking-critical fields — the ones P5's money math consumes. The
 *  published confidence is derived deterministically (validate.ts); these are inputs, not the number. */
export const FieldConfidenceSchema = z.object({
  ticker: confidence().nullable(),
  side: confidence().nullable(),
  quantity: confidence().nullable(),
  strike: confidence().nullable(),
  expiry: confidence().nullable(),
})

/** One LEG. All broker-screen dollar figures are absolute; `side` orients them. */
export const ExtractedPositionSchema = z.object({
  /** `$` strips (cashtag noise); a leading `/` is PRESERVED — it is the futures marker, and
   *  stripping it collides `/ES` with Eversource's ES (P2 review round 1). */
  ticker: z.string().min(1).max(12).transform((s) => s.toUpperCase().replace(/^\$/, '')),
  instrument: z.enum(INSTRUMENTS),
  side: z.enum(SIDES),
  /** Contracts or shares — ALWAYS positive; `side` carries the sign. */
  quantity: z.number().positive(),
  /** Per-share/per-contract-share price (NO ×100), as shown by the broker. */
  avg_price: z.number().nonnegative().nullable(),
  strike: z.number().positive().nullable(),
  /** The `.describe()` rides into the wire JSON schema — the eval showed the prompt text alone
   *  leaves M/DD expiries unresolved (63.6 % on the first labeled run); the field-level instruction
   *  is what the model actually reads at emission time. */
  expiry: isoDate().nullable().describe(
    'Full expiration date YYYY-MM-DD. Brokers display M/DD (e.g. 9/18): resolve the year from the post date — an open option expires ON or AFTER the post date, an expired one at/just before it. Never omit the year when a M/DD expiry is visible.'),
  /** Absolute dollars: paid (long) / credit received (short). */
  cost_basis: z.number().nonnegative().nullable(),
  /** Absolute dollars: liquidation value (long) / cost to close (short). */
  current_value: z.number().nonnegative().nullable(),
  /** Broker-reported P&L, signed (a loss is negative) — cross-checked, never recomputed silently. */
  pnl_abs: z.number().nullable(),
  pnl_pct: z.number().nullable(),
  realized: z.boolean().nullable(),
  /** Position-open date when the screenshot shows it — the evidence anchor (product §4.2). */
  opened_at: isoDate().nullable(),
  /** ISO 4217; null = assume USD. Non-USD positions are untrackable in v1 (product §4.1). */
  currency: z.string().length(3).transform((s) => s.toUpperCase()).nullable(),
  confidence: confidence().nullable(),
  field_confidence: FieldConfidenceSchema.nullable(),
})

/** What the vision call returns (via `generateObject`). Validation (`validate.ts`) turns this into
 *  the persisted extraction by adding derived `position_id`s + the deterministic verdicts. */
export const LlmExtractionSchema = z.object({
  screenshot_kind: z.enum(SCREENSHOT_KINDS),
  broker: z.string().max(BROKER_MAX_LEN).nullable(),
  positions: z.array(ExtractedPositionSchema).max(30),
  /** Free-text caveats the model wants on record (cropped columns, ambiguous rows). */
  notes: z.string().max(NOTES_MAX_LEN).nullable(),
  confidence: confidence().nullable(),
})

export type ExtractedPosition = z.infer<typeof ExtractedPositionSchema>
export type LlmExtraction = z.infer<typeof LlmExtractionSchema>

// --- derived direction (product §4.1) ---------------------------------------------------------------

export type PlayDirection = 'bullish' | 'bearish' | 'neutral'

/** Directional sign of one leg: long stock/long call/short put → bullish (+1); short stock/long
 *  put/short call → bearish (−1); `other` instruments → 0 (unknown payoff). */
export function legDirectionSign(p: Pick<ExtractedPosition, 'instrument' | 'side'>): -1 | 0 | 1 {
  if (p.instrument === 'other') return 0
  const long = p.side === 'long'
  if (p.instrument === 'shares' || p.instrument === 'call') return long ? 1 : -1
  return long ? -1 : 1 // put
}

/**
 * The play's overall direction, DERIVED — never asked of the model: majority sign weighted by
 * cost basis (a $10k long-shares leg outweighs a $50 hedge put). The weighting is used only when
 * EVERY sign-bearing leg carries a cost basis — with a partial-basis book, a tiny priced hedge
 * would otherwise flip the headline over a much larger unpriced position (P2 review round 1), so
 * mixed-null books fall back to plain leg count. Mixed/hedged books resolve to `neutral`, which
 * the herd measure treats as no-match (product §4.1).
 */
export function derivePlayDirection(positions: readonly ExtractedPosition[]): PlayDirection {
  let weighted = 0
  let allWeighted = true
  let unweighted = 0
  for (const p of positions) {
    const sign = legDirectionSign(p)
    if (sign === 0) continue
    unweighted += sign
    if (p.cost_basis != null && p.cost_basis > 0) weighted += sign * p.cost_basis
    else allWeighted = false
  }
  const score = allWeighted ? weighted : unweighted
  if (score > 0) return 'bullish'
  if (score < 0) return 'bearish'
  return 'neutral'
}
