import { describe, expect, it } from 'vitest'

import {
  derivePlayDirection, ExtractedPositionSchema, legDirectionSign, LlmExtractionSchema,
  type ExtractedPosition,
} from '../src/plays/extraction'

// The pinned extraction schema (P2, product §4.1) — these tests ARE the pin: sign conventions,
// full-date expiry, nullable-not-optional, and the derived (never model-asked) direction.

export const leg = (over: Partial<ExtractedPosition> = {}): ExtractedPosition => ({
  ticker: 'NVDA', instrument: 'call', side: 'long', quantity: 2, avg_price: 3.5, strike: 150,
  expiry: '2026-09-18', cost_basis: 700, current_value: 1200, pnl_abs: 500, pnl_pct: 71.4,
  realized: false, opened_at: null, currency: null, confidence: 0.9, field_confidence: null, ...over,
})

describe('ExtractedPositionSchema', () => {
  it('normalizes tickers: uppercase, cashtag/futures prefix stripped', () => {
    expect(ExtractedPositionSchema.parse(leg({ ticker: '$nvda' })).ticker).toBe('NVDA')
    expect(ExtractedPositionSchema.parse(leg({ ticker: '/es' })).ticker).toBe('ES')
  })

  it('rejects non-positive quantity — the sign lives in `side`, never in quantity', () => {
    expect(() => ExtractedPositionSchema.parse(leg({ quantity: -2 }))).toThrow()
    expect(() => ExtractedPositionSchema.parse(leg({ quantity: 0 }))).toThrow()
  })

  it('expiry must be a REAL full date — partial "1/17" or phantom dates are useless for OCC symbols', () => {
    expect(() => ExtractedPositionSchema.parse(leg({ expiry: '1/17' }))).toThrow()
    expect(() => ExtractedPositionSchema.parse(leg({ expiry: '2026-02-31' }))).toThrow()
    expect(ExtractedPositionSchema.parse(leg({ expiry: null })).expiry).toBeNull()
  })

  it('every optional field is nullable, not absent (OpenAI strict structured outputs)', () => {
    const allNull = leg({
      avg_price: null, strike: null, expiry: null, cost_basis: null, current_value: null,
      pnl_abs: null, pnl_pct: null, realized: null, opened_at: null, currency: null,
      confidence: null, field_confidence: null,
    })
    expect(ExtractedPositionSchema.parse(allNull).strike).toBeNull()
  })
})

describe('LlmExtractionSchema', () => {
  it('parses a full extraction and normalizes nested legs', () => {
    const parsed = LlmExtractionSchema.parse({
      screenshot_kind: 'single_position', broker: 'Robinhood',
      positions: [leg({ ticker: 'tsla' })], notes: null, confidence: 0.8,
    })
    expect(parsed.positions[0]!.ticker).toBe('TSLA')
  })
})

describe('direction derivation (never asked of the model)', () => {
  it('a sold put is SHORT and BULLISH — the conflation this exists to prevent', () => {
    expect(legDirectionSign({ instrument: 'put', side: 'short' })).toBe(1)
    expect(derivePlayDirection([leg({ instrument: 'put', side: 'short' })])).toBe('bullish')
  })

  it('long put / short call / short shares are bearish; long shares/call bullish', () => {
    expect(legDirectionSign({ instrument: 'put', side: 'long' })).toBe(-1)
    expect(legDirectionSign({ instrument: 'call', side: 'short' })).toBe(-1)
    expect(legDirectionSign({ instrument: 'shares', side: 'short' })).toBe(-1)
    expect(legDirectionSign({ instrument: 'shares', side: 'long' })).toBe(1)
    expect(legDirectionSign({ instrument: 'other', side: 'long' })).toBe(0)
  })

  it('majority is weighted by cost basis: a $10k position outweighs a $50 hedge', () => {
    expect(derivePlayDirection([
      leg({ instrument: 'shares', side: 'long', cost_basis: 10_000 }),
      leg({ instrument: 'put', side: 'long', cost_basis: 50 }),
    ])).toBe('bullish')
  })

  it('balanced books are neutral; missing cost bases fall back to leg count', () => {
    expect(derivePlayDirection([
      leg({ instrument: 'call', side: 'long', cost_basis: 500 }),
      leg({ instrument: 'put', side: 'long', cost_basis: 500 }),
    ])).toBe('neutral')
    expect(derivePlayDirection([
      leg({ instrument: 'call', side: 'long', cost_basis: null }),
      leg({ instrument: 'put', side: 'long', cost_basis: null }),
      leg({ instrument: 'call', side: 'long', cost_basis: null }),
    ])).toBe('bullish')
    expect(derivePlayDirection([])).toBe('neutral')
  })
})
