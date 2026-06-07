/**
 * Pure, dependency-free helpers shared by the worker and the web. Hoisted here (slice 8) so the web's
 * read-side board sort and display names can NEVER drift from the worker's live board / persisted ranks:
 *
 *  - `compareBoard` / `cmpStr` — the canonical leaderboard total order, the single definition the worker
 *    (`aggregateWindow`, `db.readHeRanksAt`) and the web (read-side sort) both use (v2-porting-spec §2/§11).
 *  - `prettyName` — display-only company-name formatting, ported 1:1 from the frozen oracle
 *    `wsb_signals/db.py` (`pretty_name` / `_NAME_SUFFIX`). Porting-spec §10 explicitly defers it to the web.
 */

/** A row carrying the canonical board-sort keys — the structural shape `compareBoard` orders on. */
export interface BoardRow {
  hE: number
  sov: number
  authors: number
  mentions: number
  ticker: string
}

/**
 * The canonical leaderboard total order — `h_e→sov→authors→mentions→ticker`, on RAW floats. One
 * definition so the live board (aggregate), the persisted ranks (`db.readHeRanksAt`), and the web's
 * read-side sort all agree. Callers reading from nullable DB columns MUST coalesce to numbers first
 * (`?? 0`) — the worker's features are non-null, but raw-float subtraction on a null would yield NaN
 * and corrupt the sort.
 */
export function compareBoard(a: BoardRow, b: BoardRow): number {
  return b.hE - a.hE || b.sov - a.sov || b.authors - a.authors || b.mentions - a.mentions || cmpStr(a.ticker, b.ticker)
}

/** Ascending string compare matching Python's `<` on str (code-point order for the ASCII tickers here). */
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// Trailing security-type descriptors Alpaca appends to equity names (not ETFs). Ported 1:1 (incl.
// alternation order) from the oracle's `_NAME_SUFFIX`; applied AFTER title-casing, so it matches the
// title-cased forms ("… Common Stock", "Class A Common Stock", …). Case-insensitive like the original.
const NAME_SUFFIX
  = /\s*[,.]?\s+(?:Class\s+[A-Z]\s+)?(?:Common Stock|Ordinary Shares|Common Shares|Depositary Shares|American Depositary Shares|Depositary Receipts|Sponsored Adr)\s*$/i

/**
 * Title-case matching Python's `str.title()` for our input domain: each maximal run of letters becomes
 * first-upper / rest-lower (so "O'BRIEN"→"O'Brien", "AT&T"→"At&T" — the same boundary behavior the
 * oracle relied on). Unicode-letter aware via `\p{L}`.
 */
function titleCase(s: string): string {
  return s.replace(/\p{L}+/gu, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
}

/**
 * Human-readable company name from the raw (UPPERCASE) Alpaca name; '' if unknown. Mirrors the oracle's
 * `pretty_name`: title-case, strip the verbose security-type suffix ("BROADCOM INC. COMMON STOCK" →
 * "Broadcom Inc.") but leave ETF names intact; optionally truncate (with an ellipsis) for narrow columns.
 */
export function prettyName(raw: string | null | undefined, maxLen = 0): string {
  if (!raw) return ''
  let name = titleCase(raw).replace(NAME_SUFFIX, '').trim()
  if (maxLen && name.length > maxLen) name = `${name.slice(0, maxLen - 1)}…`
  return name
}
