import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { direction } from '../src/classify'
import { TickerExtractor } from '../src/extract'

// Adversarial property coverage beyond the fixture corpus (v2-porting-spec.md §9). These assert
// structural invariants that must hold for ANY input — including weird Unicode that stresses the
// regex / case-folding landmine.
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
const symbol = fc.array(fc.constantFrom(...UPPER), { minLength: 1, maxLength: 5 }).map((a) => a.join(''))

describe('extract/classify properties', () => {
  it('extract() == the ACCEPT-decision subset of classify(), in order', () => {
    const ext = new TickerExtractor(new Set(['THE', 'AND']), { whitelist: null, ambiguous: new Set(['DRAM']) })
    fc.assert(fc.property(fc.string(), (text) => {
      const accepted = ext.classify(text)
        .filter(([, d]) => d === 'cashtag' || d === 'whitelist_ok' || d === 'open_ok')
        .map(([s]) => s)
      expect(ext.extract(text)).toEqual(accepted)
    }))
  })

  it('a $-cashtag is always accepted, even against stop + empty-whitelist + ambiguous all at once', () => {
    fc.assert(fc.property(symbol, (tok) => {
      // Stack every gate against the token: it's stoplisted, not in the (empty) whitelist, and ambiguous.
      const ext = new TickerExtractor(new Set([tok]), { whitelist: new Set(), ambiguous: new Set([tok]) })
      const text = `$${tok} to the moon`
      expect(ext.classify(text)).toContainEqual([tok, 'cashtag'])
      expect(ext.extract(text)).toContain(tok)
    }))
  })

  it('direction() always returns a valid label and never throws on arbitrary text', () => {
    fc.assert(fc.property(fc.string(), (text) => {
      expect(['bull', 'bear', 'neutral']).toContain(direction(text))
    }))
  })
})
