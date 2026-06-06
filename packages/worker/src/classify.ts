/**
 * Direction classifier — TS port of the frozen v0.0.1 `wsb_signals/classify.py` (architecture §2.3).
 *
 * WSB lexical sentiment is ironic, so *direction* (calls/puts, long/short, bought/sold) is the
 * reliable signal, not generic positivity. Bull and bear counts are tallied INDEPENDENTLY (mirroring
 * Python's two `sum(...)` passes) — the sets are disjoint so it can't double-count, but we keep the
 * structure exact. Tokenizer `[a-z']+` runs over the lowercased text.
 *
 * Parity: covered by the `direction` field of every fixtures/extract_classify.json case.
 */
export const BULL: ReadonlySet<string> = new Set([
  'call', 'calls', 'long', 'buy', 'buying', 'bought', 'bull', 'bullish', 'moon', 'mooning',
  'rocket', 'rockets', 'loading', 'loaded', 'leaps', 'upside', 'squeeze', 'yolo', 'tendies',
])

export const BEAR: ReadonlySet<string> = new Set([
  'put', 'puts', 'short', 'shorting', 'shorted', 'sell', 'selling', 'sold', 'bear', 'bearish',
  'drill', 'drilling', 'downside', 'crash', 'crashing', 'tank', 'tanking', 'hedge', 'dump',
])

const WORD = /[a-z']+/g

export type Direction = 'bull' | 'bear' | 'neutral'

/** Return 'bull' | 'bear' | 'neutral' from the directional token balance. */
export function direction(text: string | null | undefined): Direction {
  if (!text) return 'neutral'
  let bull = 0
  let bear = 0
  for (const m of text.toLowerCase().matchAll(WORD)) {
    const t = m[0]
    if (BULL.has(t)) bull++
    if (BEAR.has(t)) bear++
  }
  if (bull > bear) return 'bull'
  if (bear > bull) return 'bear'
  return 'neutral'
}
