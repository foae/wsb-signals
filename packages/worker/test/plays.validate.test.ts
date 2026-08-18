import { describe, expect, it } from 'vitest'

import type { LlmExtraction } from '../src/plays/extraction'
import {
  arithmeticOk, assignPositionIds, deriveConfidence, tickerOutcome, validateExtraction,
  type ValidatedPosition,
} from '../src/plays/validate'
import { leg } from './plays.extraction.test'

// The deterministic validation pass (product §4.1): three-outcome ticker check (invariant P3 — the
// system never silently invents a ticker), P&L arithmetic cross-check, derived confidence.

const LISTED = new Set(['NVDA', 'TSLA'])
const ctx = (over: Partial<{ mediaArchived: boolean }> = {}) =>
  ({ isListedTicker: (t: string) => LISTED.has(t), mediaArchived: true, ...over })

describe('assignPositionIds', () => {
  it('is deterministic from leg content — re-extraction keeps P5 marks aligned', () => {
    const legs = [leg(), leg({ instrument: 'put', strike: 140 })]
    expect(assignPositionIds(legs)).toEqual(assignPositionIds(legs.map((l) => ({ ...l }))))
    expect(assignPositionIds(legs)[0]).toBe('nvda:call:long:150:2026-09-18')
  })

  it('identical legs get ordinal suffixes, in order', () => {
    expect(assignPositionIds([leg(), leg()])).toEqual([
      'nvda:call:long:150:2026-09-18', 'nvda:call:long:150:2026-09-18:2',
    ])
  })
})

describe('tickerOutcome (three outcomes, never two)', () => {
  it('whitelist hit → validated; SPX/futures/crypto → known_non_equity; junk → unvalidated', () => {
    const isListed = (t: string) => LISTED.has(t)
    expect(tickerOutcome('NVDA', isListed)).toBe('validated')
    expect(tickerOutcome('SPX', isListed)).toBe('known_non_equity')
    expect(tickerOutcome('ES', isListed)).toBe('known_non_equity') // '/ES' arrives stripped by the schema
    expect(tickerOutcome('ZZZZQ', isListed)).toBe('unvalidated')
  })
})

describe('arithmeticOk', () => {
  it('long: pnl ≈ value − cost within max(2 % cost, $1)', () => {
    expect(arithmeticOk(leg({ cost_basis: 700, current_value: 1200, pnl_abs: 500 }))).toBe(true)
    expect(arithmeticOk(leg({ cost_basis: 700, current_value: 1200, pnl_abs: 510 }))).toBe(true) // within 2 %
    expect(arithmeticOk(leg({ cost_basis: 700, current_value: 1200, pnl_abs: 600 }))).toBe(false)
  })
  it('short: pnl ≈ credit − cost-to-close (orientation matters)', () => {
    const short = leg({ side: 'short', cost_basis: 300, current_value: 100, pnl_abs: 200 })
    expect(arithmeticOk(short)).toBe(true)
    expect(arithmeticOk({ ...short, pnl_abs: -200 })).toBe(false) // long-oriented sign would fail
  })
  it('unverifiable (missing figures) is null, not a pass or fail', () => {
    expect(arithmeticOk(leg({ pnl_abs: null }))).toBeNull()
    expect(arithmeticOk(leg({ cost_basis: null }))).toBeNull()
  })
})

describe('deriveConfidence (documented formula)', () => {
  const vp = (over: Partial<ValidatedPosition> = {}): ValidatedPosition =>
    ({ ...leg(), position_id: 'x', ticker_outcome: 'validated', arithmetic_ok: true, ...over })

  it('clean validated extraction with media ≈ 0.9 blended with the model self-report', () => {
    expect(deriveConfidence([vp()], ctx(), null)).toBe(0.9)
    expect(deriveConfidence([vp()], ctx(), 0.6)).toBe(0.83) // 0.75·0.9 + 0.25·0.6
  })
  it('any unvalidated ticker halves the base; arithmetic failures subtract; text-only multiplies ×0.8', () => {
    expect(deriveConfidence([vp({ ticker_outcome: 'unvalidated' })], ctx(), null)).toBe(0.5)
    expect(deriveConfidence([vp({ arithmetic_ok: false })], ctx(), null)).toBe(0.75)
    expect(deriveConfidence([vp()], ctx({ mediaArchived: false }), null)).toBe(0.72)
  })
  it('known_non_equity keeps NORMAL confidence — SPX is absent from the whitelist by construction', () => {
    expect(deriveConfidence([vp({ ticker_outcome: 'known_non_equity' })], ctx(), null)).toBe(0.9)
  })
  it('zero positions is low confidence; floor holds under many failures', () => {
    expect(deriveConfidence([], ctx(), null)).toBe(0.3)
    const bad = Array.from({ length: 9 }, () => vp({ arithmetic_ok: false }))
    expect(deriveConfidence(bad, ctx(), null)).toBe(0.1)
  })
})

describe('validateExtraction (the full pass)', () => {
  it('assembles the persisted PlayExtraction: ids, outcomes, derived direction + confidence', () => {
    const llm: LlmExtraction = {
      screenshot_kind: 'single_position', broker: 'Robinhood',
      positions: [leg(), leg({
        // Short-oriented figures: credit 300, cost-to-close 100 → +200 (arithmeticOk's short branch).
        ticker: 'SPX', instrument: 'put', side: 'short', strike: 6000,
        cost_basis: 300, current_value: 100, pnl_abs: 200, pnl_pct: 66.7,
      })],
      notes: null, confidence: 0.8,
    }
    const out = validateExtraction(llm, ctx())
    expect(out.schema_version).toBe('extract-schema-v1')
    expect(out.positions.map((p) => p.ticker_outcome)).toEqual(['validated', 'known_non_equity'])
    expect(out.direction).toBe('bullish') // long call + short put both bullish
    expect(out.model_confidence).toBe(0.8)
    expect(out.confidence).toBeGreaterThan(0.8)
    expect(new Set(out.positions.map((p) => p.position_id)).size).toBe(2)
  })
})
