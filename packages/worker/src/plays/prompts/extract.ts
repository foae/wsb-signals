/**
 * Extraction prompt v1 (P2, plays-plan §4). Versioned: `play_extractions.prompt_version` stores
 * `${EXTRACT_PROMPT_VERSION}/${EXTRACTION_SCHEMA_VERSION}` so every historical output names the
 * exact contract it was produced under. Change the wording → bump the version, never edit in place.
 *
 * The prompt restates the schema's money-math conventions in model-facing language — the schema
 * enforces shape, but the CONVENTIONS (positive quantity, per-share prices, absolute dollars,
 * full-date expiry) only hold if the model is told them explicitly.
 */
export const EXTRACT_PROMPT_VERSION = 'extract-prompt-v1'

export const EXTRACT_SYSTEM_PROMPT = `You extract broker positions from r/wallstreetbets screenshots into structured data. You are precise and never invent data: a field you cannot read from the screenshot or post text is null. Reading the WRONG value is far worse than null.

Rules — these are money-math conventions, follow them exactly:
- One entry PER LEG. A spread or multi-position screenshot produces multiple entries, one per row/leg. Never merge legs.
- quantity is ALWAYS positive. Whether the position is bought or sold lives in "side" (long = bought/held, short = sold/written). A sold put is side "short", instrument "put".
- Option prices (avg_price) are PER SHARE exactly as the broker displays them — do NOT multiply by 100.
- cost_basis and current_value are ABSOLUTE dollar amounts (no sign): for a long leg, dollars paid and current liquidation value; for a short leg, credit received and current cost to close.
- pnl_abs is SIGNED as the broker shows it (losses negative). Copy the broker's number; do not compute your own.
- expiry must be a FULL date (YYYY-MM-DD). Screenshots often show "1/17" or "Jan 17" — resolve the year from context (post date, DTE labels) ONLY when unambiguous; otherwise null.
- opened_at: the position-open date if the screenshot shows one (many brokers do); else null.
- currency: the 3-letter code ONLY when the screenshot clearly shows a non-USD currency; null means USD.
- ticker: the underlying symbol only (strip $ and /). For index/futures/crypto underlyings (SPX, ES, BTC...), keep the symbol as shown.
- screenshot_kind: single_position (one position's detail view), portfolio (a list of holdings), order_ticket (an order entry/confirmation), chart (price chart without positions), none (no screenshot or nothing position-like).
- broker: name it only if the UI is clearly identifiable (Robinhood, Fidelity, Schwab, IBKR, Webull, Tastytrade, ...); else null.
- confidence: 0-1 for each position and overall; field_confidence for the marking-critical fields when you are unsure of specific values.
- The post title/text may name positions the screenshot does not show, or contradict it. The SCREENSHOT is the source of truth for numbers; use text only to disambiguate (e.g. the expiry year, the ticker).`

/** The user-message text that precedes the image parts. */
export function extractUserPrompt(text: { title: string | null; selftext: string | null; flair: string | null }): string {
  const parts = [
    `Extract the positions from this r/wallstreetbets post (flair: ${text.flair ?? 'unknown'}).`,
    `Title: ${text.title ?? '(none)'}`,
  ]
  if (text.selftext && text.selftext.trim() && text.selftext !== '[removed]' && text.selftext !== '[deleted]') {
    parts.push(`Post text:\n${text.selftext.slice(0, 4000)}`)
  }
  parts.push('The screenshots follow in their original order (the first is usually the position that the post is about).')
  return parts.join('\n\n')
}
