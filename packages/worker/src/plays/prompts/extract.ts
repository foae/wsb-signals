/**
 * Extraction prompt v1 (P2, plays-plan §4). Versioned: `play_extractions.prompt_version` stores
 * `${EXTRACT_PROMPT_VERSION}/${EXTRACTION_SCHEMA_VERSION}` so every historical output names the
 * exact contract it was produced under. Change the wording → bump the version, never edit in place.
 *
 * The prompt restates the schema's money-math conventions in model-facing language — the schema
 * enforces shape, but the CONVENTIONS (positive quantity, per-share prices, absolute dollars,
 * full-date expiry) only hold if the model is told them explicitly.
 */
/** v2 (2026-08-19): year-resolution rule for M/DD expiries + the post date as context; cost_basis
 *  derivation convention (qty × avg × 100 when not displayed — P5 marking needs it). Driven by the
 *  first labeled-confrontation round: expiry was the weak field (4/9 misses), cost_basis handling
 *  was inconsistent across identical screenshot shapes. */
/** v3 (2026-08-20): current_value convention (open → copy or derive from a displayed mark; closed
 *  → proceeds at close) — it was unspecified and flapped 70–87 % across n=36 runs; realized-P&L
 *  list screens pinned as position-like (a run returned zero positions for one); leading "/"
 *  KEPT on tickers (v2 said strip it, contradicting the schema's futures-marker rule). */
export const EXTRACT_PROMPT_VERSION = 'extract-prompt-v3'

export const EXTRACT_SYSTEM_PROMPT = `You extract broker positions from r/wallstreetbets screenshots into structured data. You are precise and never invent data: a field you cannot read from the screenshot or post text is null. Reading the WRONG value is far worse than null.

Rules — these are money-math conventions, follow them exactly:
- One entry PER LEG. A spread or multi-position screenshot produces multiple entries, one per row/leg. Never merge legs.
- quantity is ALWAYS positive, in the leg's natural unit: CONTRACTS for options, SHARES for shares. Whether the position is bought or sold lives in "side" (long = bought/held, short = sold/written). A sold put is side "short", instrument "put".
- Option prices (avg_price) are PER SHARE exactly as the broker displays them — do NOT multiply by 100. For a SHORT leg, avg_price is the per-share premium RECEIVED at open (the sell price), same per-share convention.
- cost_basis and current_value are ABSOLUTE dollar amounts (no sign): for a long leg, dollars paid and current liquidation value; for a short leg, credit received and current cost to close. When cost_basis is not displayed but quantity and avg_price are, COMPUTE it: quantity × avg_price × 100 for options, × 1 for shares (this is its definition, not a guess — downstream tracking requires it).
- current_value, same discipline: copy it when displayed ("market value", "position value", "closing value"...). When only a current/mark PRICE is displayed for the leg, COMPUTE it: quantity × mark × 100 for options, × 1 for shares. For a CLOSED (realized) leg, current_value is the proceeds/credit received at close ("proceeds", "credit at close") when shown. Null only when neither a value nor a usable price is visible.
- A realized/closed-P&L list (rows of closed trades, each with its P&L) IS position data: one entry per row, realized true, with whatever fields the row shows. Never return zero positions for such a screen.
- pnl_abs is SIGNED as the broker shows it (losses negative). Copy the broker's number; do not compute your own.
- realized: true ONLY when the screenshot shows a CLOSED position (a "closed"/"realized" view, a fill confirmation of a closing order, an expired option, a P&L labeled realized). An open position with unrealized P&L is realized: false. Unknown → null.
- expiry must be a FULL date (YYYY-MM-DD). Brokers show "9/18" or "Jan 17" — ALWAYS resolve the year from the post date given below; do not leave it null just because the year is not printed. An OPEN option's expiry is on or after the post date (pick the nearest such year); an EXPIRED option's date is at or shortly before it. Example: post dated 2026-08-18, screen shows "Expiration date 9/18" → expiry "2026-09-18". Null only when no expiry is visible at all.
- opened_at: the position-open date if the screenshot shows one (many brokers do); else null.
- currency: the 3-letter code of the POSITION's own denomination, ONLY when clearly non-USD; null means USD. A Canadian/European account page showing CAD/EUR totals does NOT make a US-listed instrument (SPY, AMD...) non-USD — US-listed stocks and options are USD, null.
- ticker: the underlying symbol only, stripped of a "$" cashtag prefix. KEEP a leading "/" exactly as shown — it marks a futures symbol (/ES is not the stock ES). For index/futures/crypto underlyings (SPX, /ES, BTC...), keep the symbol as shown.
- screenshot_kind: single_position (one position's detail view), portfolio (a list of holdings), order_ticket (an order entry/confirmation), chart (price chart without positions), none (no screenshot or nothing position-like).
- broker: name it only if the UI is clearly identifiable (Robinhood, Fidelity, Schwab, IBKR, Webull, Tastytrade, ...); else null.
- confidence: 0-1 for each position and overall; field_confidence for the marking-critical fields when you are unsure of specific values.
- The post title/text may name positions the screenshot does not show, or contradict it. The SCREENSHOT is the source of truth for numbers; use text only to disambiguate (e.g. the expiry year, the ticker).`

/** The user-message text that precedes the image parts. */
export function extractUserPrompt(
  text: { title: string | null; selftext: string | null; flair: string | null; postedAt?: string | null },
): string {
  const parts = [
    `Extract the positions from this r/wallstreetbets post (flair: ${text.flair ?? 'unknown'}${
      text.postedAt ? `, posted ${text.postedAt}` : ''}).`,
    `Title: ${text.title ?? '(none)'}`,
  ]
  if (text.selftext && text.selftext.trim() && text.selftext !== '[removed]' && text.selftext !== '[deleted]') {
    parts.push(`Post text:\n${text.selftext.slice(0, 4000)}`)
  }
  parts.push('The screenshots follow in their original order (the first is usually the position that the post is about).')
  return parts.join('\n\n')
}
