/**
 * The `PlayInterpretation` schema (P3, plays-plan §5; taxonomy per product §4.3).
 *
 * The category enum is built PER CALL, not pinned: `herd-following` is only in the options offered
 * to the model when the deterministic radar herd evidence clears the configured threshold —
 * invariant P4 enforced structurally, not by instruction. Everything else mirrors the extraction
 * schema's conventions: `.nullable()` never `.optional()` (OpenAI strict mode), free-text length
 * pins shared with a pre-parse truncation repair (the wire schema loses `maxLength` to
 * `strictifyJsonSchema`, so the repair is the only guard between a chatty model and a burned call —
 * the exact failure class P2 hit live on `notes`).
 */
import { z } from 'zod'

/** Bump when the schema shape changes; stored per run in `play_interpretations.prompt_version`
 *  together with the prompt version (same contract-naming rule as extraction). */
export const INTERPRET_SCHEMA_VERSION = 'interpret-schema-v1'
/** Versioned separately from prompt/schema (product §4.3) — re-runs stay comparable only when the
 *  category MEANINGS are pinned; changing a category's semantics is a taxonomy bump. */
export const TAXONOMY_VERSION = 'taxonomy-v1'

/** Taxonomy v1 (product §4.3): exactly one primary category per play. */
export const CATEGORIES = [
  'dumb-luck', 'high-risk-high-reward', 'herd-following', 'earnings-gamble',
  'bag-holding', 'disciplined-play', 'unclassifiable',
] as const
export type PlayCategory = (typeof CATEGORIES)[number]

/** Free-text length pins — shared by the schema and `sanitizeRawInterpretation` (which truncates
 *  instead of failing; see the module doc for why the schema alone can't enforce them). */
export const THESIS_MAX_LEN = 400
export const OUTCOME_MAX_LEN = 400
export const CONTEXT_MAX_LEN = 700
export const SUMMARY_MAX_LEN = 900
export const TLDR_MAX_LEN = 160
export const TAG_MAX_LEN = 30
export const MAX_TAGS = 8

/**
 * Build the schema for one interpret call. `allowHerd` is the structural herd gate (invariant P4):
 * below threshold the model cannot even EMIT `herd-following` — strict mode rejects it at the
 * provider, and the parse rejects it here.
 */
export function buildInterpretationSchema(allowHerd: boolean): z.ZodType<LlmInterpretation> {
  const categories = allowHerd ? CATEGORIES : CATEGORIES.filter((c) => c !== 'herd-following')
  return z.object({
    /** What the gamble WAS — the bet, in one or two sentences. */
    thesis: z.string().min(1).max(THESIS_MAX_LEN),
    /** How it went, per the screenshot — the posted P&L IS the play's content (plan §5). */
    outcome: z.string().min(1).max(OUTCOME_MAX_LEN),
    /** Market/event background. Model-recalled facts MUST carry the "model-recalled, unverified"
     *  label in this text (product §4.2 — no free earnings-calendar API to verify against). */
    context: z.string().max(CONTEXT_MAX_LEN).nullable(),
    category: z.enum(categories as [PlayCategory, ...PlayCategory[]]),
    /** Open set, seeded in the prompt; lowercase kebab by convention. */
    tags: z.array(z.string().min(1).max(TAG_MAX_LEN).transform((s) => s.toLowerCase())).max(MAX_TAGS),
    /** 2–4 sentences for the detail page. */
    summary: z.string().min(1).max(SUMMARY_MAX_LEN),
    /** One line for the card. */
    tldr: z.string().min(1).max(TLDR_MAX_LEN),
    /** Model self-report; kept for calibration — the board confidence stays the extraction's
     *  derived one (validate.ts), which is the evidence-grounded number. */
    confidence: z.number().min(0).max(1).nullable(),
  }) as z.ZodType<LlmInterpretation>
}

export interface LlmInterpretation {
  thesis: string
  outcome: string
  context: string | null
  category: PlayCategory
  tags: string[]
  summary: string
  tldr: string
  confidence: number | null
}

/** The persisted interpretation (`play_interpretations.output`). */
export interface PlayInterpretation extends LlmInterpretation {
  schema_version: typeof INTERPRET_SCHEMA_VERSION
  taxonomy_version: typeof TAXONOMY_VERSION
  /** Whether the herd category was structurally available to this run (invariant P4 audit trail). */
  herd_allowed: boolean
}

/** Truncate overlong free text and drop junk tags BEFORE schema parse — a paid interpretation must
 *  not burn on a chatty summary (the P2 `notes` lesson). Category/shape problems still hard-fail. */
export function sanitizeRawInterpretation(raw: unknown): { value: unknown; repaired: string[] } {
  if (raw == null || typeof raw !== 'object') return { value: raw, repaired: [] }
  const obj = { ...(raw as Record<string, unknown>) }
  const repaired: string[] = []
  const pins = [
    ['thesis', THESIS_MAX_LEN], ['outcome', OUTCOME_MAX_LEN], ['context', CONTEXT_MAX_LEN],
    ['summary', SUMMARY_MAX_LEN], ['tldr', TLDR_MAX_LEN],
  ] as const
  for (const [k, max] of pins) {
    if (typeof obj[k] === 'string' && (obj[k] as string).length > max) {
      repaired.push(`${k}: truncated ${(obj[k] as string).length}→${max} chars`)
      obj[k] = (obj[k] as string).slice(0, max)
    }
  }
  if (Array.isArray(obj.tags)) {
    const tags = obj.tags
      .filter((t) => {
        const ok = typeof t === 'string' && t.length > 0
        if (!ok) repaired.push(`tags: dropped non-string entry ${JSON.stringify(t)}`)
        return ok
      })
      .map((t: string) => {
        if (t.length > TAG_MAX_LEN) {
          repaired.push(`tags: truncated "${t.slice(0, 40)}"`)
          return t.slice(0, TAG_MAX_LEN)
        }
        return t
      })
    if (tags.length > MAX_TAGS) repaired.push(`tags: capped ${tags.length}→${MAX_TAGS}`)
    obj.tags = tags.slice(0, MAX_TAGS)
  }
  return { value: obj, repaired }
}

/**
 * Sanitize + parse + enforce the free-text side of the herd gate: invariant P4's prompt-level rule
 * ("no herd claims in tags") backed by code — below threshold, herd-ish TAGS are stripped (a tag is
 * a machine-consumed label, so a stray "herd" tag would leak the claim into filters). Free-running
 * prose stays the prompt's job. Shared by both analyzer impls so the gate can't drift between them.
 */
export function parseInterpretation(raw: unknown, allowHerd: boolean): { value: LlmInterpretation; repaired: string[] } {
  const { value, repaired } = sanitizeRawInterpretation(raw)
  const parsed = buildInterpretationSchema(allowHerd).parse(value)
  if (!allowHerd) {
    const kept = parsed.tags.filter((t) => !t.includes('herd'))
    if (kept.length !== parsed.tags.length) {
      repaired.push('tags: stripped herd claim (below threshold — invariant P4)')
      parsed.tags = kept
    }
  }
  return { value: parsed, repaired }
}
