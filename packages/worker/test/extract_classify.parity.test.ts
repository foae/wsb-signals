import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { direction } from '../src/classify'
import { DEFAULT_REGEX, hasTradingContext, type Decision, TickerExtractor } from '../src/extract'

// Slice-1 parity gate: the ported extractor/classifier must reproduce the frozen v0.0.1 oracle on the
// committed golden corpus (fixtures/extract_classify.json, v2-porting-spec.md §3). Same fixture feeds
// both languages; this asserts identical classify()/extract()/direction() per case.
interface Fixture {
  regex: string
  wordsets: { stoplist: string[]; whitelist: string[]; ambiguous: string[] }
  cases: Array<{
    id: string
    mode: 'whitelist' | 'open'
    text: string
    classify: Array<[string, Decision]>
    extract: string[]
    direction: 'bull' | 'bear' | 'neutral'
  }>
}

const fx: Fixture = JSON.parse(
  readFileSync(new URL('../../../fixtures/extract_classify.json', import.meta.url), 'utf8'),
)

const stop = new Set(fx.wordsets.stoplist)
const whitelist = new Set(fx.wordsets.whitelist)
const ambiguous = new Set(fx.wordsets.ambiguous)

function extractorFor(mode: 'whitelist' | 'open'): TickerExtractor {
  return mode === 'whitelist'
    ? new TickerExtractor(stop, { whitelist, ambiguous })
    : new TickerExtractor(stop, { whitelist: null, ambiguous })
}

describe('extract/classify parity (B3)', () => {
  it('ports the exact candidate regex', () => {
    expect(DEFAULT_REGEX.source).toBe(fx.regex)
  })

  for (const c of fx.cases) {
    it(`${c.id} — classify/extract/direction match the oracle`, () => {
      const ext = extractorFor(c.mode)
      expect(ext.classify(c.text)).toEqual(c.classify)
      expect(ext.extract(c.text)).toEqual(c.extract)
      expect(direction(c.text)).toBe(c.direction)
    })
  }
})

// Direct port of tests/test_extract.py::test_has_trading_context (the $-and-vocab proxy).
describe('hasTradingContext', () => {
  it('matches the v0.0.1 unit cases', () => {
    expect(hasTradingContext('loaded up on calls')).toBe(true)
    expect(hasTradingContext('grabbed some $SPY')).toBe(true) // $ alone qualifies
    expect(hasTradingContext('i need more dram for my pc')).toBe(false)
    expect(hasTradingContext('')).toBe(false)
    expect(hasTradingContext(null)).toBe(false)
  })
})
