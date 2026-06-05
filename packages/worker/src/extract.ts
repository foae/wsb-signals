/**
 * Ticker extractor — TS port of the frozen v0.0.1 `wsb_signals/extract.py` (architecture §2.2).
 *
 * Parity contract: gated on fixtures/extract_classify.json + fixtures/wordset_loader.json
 * (v2-porting-spec.md §3). Decision precedence is exact:
 *   cashtag > too_short > stop > not_listed > ambiguous-gate > accept.
 *
 * Cross-language landmines handled here:
 *  - the candidate regex stays ASCII (no `u` flag) and MUST be global for `matchAll`;
 *  - `match[1]` is `undefined` (not Python's `None`) when the optional `$` group is absent — the
 *    `if (cash)` truthiness check is equivalent;
 *  - the wordset loader mirrors Python `str.split()`: split on ANY whitespace run, drop empties.
 */

/** Optional `$`-cashtag + 1–5 uppercase letters, bounded by non-alnum. Group 1 = `$`, group 2 = symbol.
 *  Global flag is required by `matchAll`; `matchAll` clones the regex, so sharing this is lastIndex-safe. */
export const DEFAULT_REGEX = /(?<![A-Za-z0-9])(\$)?([A-Z]{1,5})(?![A-Za-z0-9])/g

/** Options / position vocabulary — the §2.2 trading-context proxy (admits ambiguous word-tickers). */
export const TRADING_WORDS: ReadonlySet<string> = new Set([
  'call', 'calls', 'put', 'puts', 'strike', 'strikes', 'expiry', 'expiration', 'leaps',
  'contracts', 'contract', 'premium', 'otm', 'itm', 'atm', 'theta', 'gamma', 'delta', 'vega',
  'long', 'short', 'shares', 'bought', 'sold', 'buy', 'sell', 'position', 'earnings',
  'squeeze', 'bullish', 'bearish', 'moon', 'yolo',
])

const CTX_WORD = /[a-z]+/g

/** True if the text carries options/position language (or a `$`) — the §2.2 co-occurrence proxy. */
export function hasTradingContext(text: string | null | undefined): boolean {
  if (!text) return false
  if (text.includes('$')) return true
  for (const m of text.toLowerCase().matchAll(CTX_WORD)) {
    if (TRADING_WORDS.has(m[0])) return true
  }
  return false
}

export type Decision =
  | 'cashtag' | 'too_short' | 'stop' | 'not_listed' | 'ambig_no_context' | 'whitelist_ok' | 'open_ok'

/** accepted = cashtag / whitelist_ok / open_ok (mirrors `TickerExtractor.ACCEPT`). */
const ACCEPT: ReadonlySet<Decision> = new Set<Decision>(['cashtag', 'whitelist_ok', 'open_ok'])

export interface ExtractorOptions {
  regex?: RegExp
  whitelist?: ReadonlySet<string> | null // null = accept any non-stop candidate (no whitelist loaded)
  ambiguous?: ReadonlySet<string> | null
}

export class TickerExtractor {
  private readonly stop: ReadonlySet<string>
  private readonly re: RegExp
  private readonly whitelist: ReadonlySet<string> | null
  private readonly ambiguous: ReadonlySet<string>

  constructor(stop: ReadonlySet<string>, opts: ExtractorOptions = {}) {
    this.stop = stop
    const re = opts.regex ?? DEFAULT_REGEX
    // `matchAll` throws on a non-global regex; ensure `g` so a config-supplied pattern still works.
    this.re = re.global ? re : new RegExp(re.source, `${re.flags}g`)
    this.whitelist = opts.whitelist ?? null
    this.ambiguous = opts.ambiguous ?? new Set()
  }

  /** Fail-closed fallback: an EMPTY whitelist rejects every bare token, so only `$`-cashtags pass. */
  static cashtagOnly(stop: ReadonlySet<string>, opts: { regex?: RegExp } = {}): TickerExtractor {
    return new TickerExtractor(stop, { regex: opts.regex, whitelist: new Set() })
  }

  /** Per candidate token, return [symbol, decision] in left-to-right match order. */
  classify(text: string | null | undefined): Array<[string, Decision]> {
    const out: Array<[string, Decision]> = []
    let ctx: boolean | null = null // compute trading context at most once per text
    for (const m of (text ?? '').matchAll(this.re)) {
      const cash = m[1]
      const sym = m[2] as string
      let d: Decision
      if (cash) {
        d = 'cashtag' // $-cashtag: high confidence, bypasses stop / whitelist / ambiguous
      } else if (sym.length < 2) {
        d = 'too_short' // bare single letter — too noisy without a cashtag
      } else if (this.stop.has(sym)) {
        d = 'stop'
      } else if (this.whitelist !== null && !this.whitelist.has(sym)) {
        d = 'not_listed'
      } else if (this.ambiguous.has(sym)) {
        if (ctx === null) ctx = hasTradingContext(text)
        d = ctx ? (this.whitelist !== null ? 'whitelist_ok' : 'open_ok') : 'ambig_no_context'
      } else {
        d = this.whitelist !== null ? 'whitelist_ok' : 'open_ok'
      }
      out.push([sym, d])
    }
    return out
  }

  extract(text: string | null | undefined): string[] {
    return this.classify(text).filter(([, d]) => ACCEPT.has(d)).map(([sym]) => sym)
  }
}

/**
 * Parse a stoplist/whitelist/ambiguous file body into a set — port of `_load_wordset`.
 * Mirrors Python exactly: take text before the first `#`, strip, split on ANY whitespace run
 * (dropping empties), dedup. Pass the file CONTENTS (callers own fs); splits on LF/CRLF/CR.
 */
export function loadWordset(content: string): Set<string> {
  const words = new Set<string>()
  for (const rawLine of content.split(/\r\n|\r|\n/)) {
    const line = (rawLine.split('#', 1)[0] ?? '').trim()
    if (!line) continue
    for (const w of line.split(/\s+/)) {
      if (w) words.add(w)
    }
  }
  return words
}
