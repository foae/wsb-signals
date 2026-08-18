import { describe, expect, it } from 'vitest'

import { markPlay, multiplierFor, type MarkablePosition } from '../src/plays/marking'
import { leg } from './plays.extraction.test'

// The P2↔P5 pin (plays-plan §4): this math + the pinned schema is what P5's outcome tracking
// consumes. Sign conventions, the ×100 multiplier, and per-leg spread summing are asserted here so
// the contract cannot drift silently between slices.

const pos = (id: string, over: Partial<MarkablePosition> = {}): MarkablePosition =>
  ({ ...leg(), position_id: id, ...over })

describe('multiplierFor', () => {
  it('options ×100, shares ×1, other unmarkable', () => {
    expect(multiplierFor('call')).toBe(100)
    expect(multiplierFor('put')).toBe(100)
    expect(multiplierFor('shares')).toBe(1)
    expect(multiplierFor('other')).toBeNull()
  })
})

describe('markPlay', () => {
  it('long call: quote is PER-SHARE, value applies ×100 exactly once', () => {
    // 2 contracts @ $6.00/share → $1200 value; cost $700 → +$500 (+71.4%)
    const r = markPlay([pos('a', { quantity: 2, cost_basis: 700 })], { a: { price: 6 } })
    expect(r.positions[0]).toMatchObject({ markable: true, markValue: 1200, pnlAbs: 500 })
    expect(r.positions[0]!.pnlPct).toBeCloseTo(71.43, 1)
  })

  it('short put: P&L = credit − cost-to-close (side orients, quantity stays positive)', () => {
    // Sold 1 put for $300 credit; closing costs $100 → +$200. Winning short = positive P&L.
    const r = markPlay(
      [pos('a', { instrument: 'put', side: 'short', quantity: 1, cost_basis: 300 })],
      { a: { price: 1 } }) // $1.00/share × 100 = $100 to close
    expect(r.positions[0]).toMatchObject({ markable: true, markValue: 100, pnlAbs: 200 })
  })

  it('shares: no multiplier', () => {
    const r = markPlay(
      [pos('a', { instrument: 'shares', quantity: 10, cost_basis: 1000 })], { a: { price: 120 } })
    expect(r.positions[0]).toMatchObject({ markValue: 1200, pnlAbs: 200 })
  })

  it('a debit spread is marked per-leg and SUMMED — never the long leg alone (phantom-gain landmine)', () => {
    // Long 150C (cost 700) + short 160C (credit 300). Quotes: 6.00 / 2.00.
    const r = markPlay([
      pos('long', { strike: 150, cost_basis: 700, quantity: 2 }),
      pos('short', { strike: 160, side: 'short', cost_basis: 300, quantity: 2 }),
    ], { long: { price: 6 }, short: { price: 2 } })
    // long: 1200 − 700 = +500; short: 300 − 400 = −100 → total +400, NOT +500.
    expect(r.totalPnlAbs).toBe(400)
    expect(r.totalCostBasis).toBe(1000)
    expect(r.markedCount).toBe(2)
  })

  it('realized legs are final — marking them would be fiction', () => {
    const r = markPlay([pos('a', { realized: true })], { a: { price: 99 } })
    expect(r.positions[0]).toMatchObject({ markable: false, reason: 'realized', pnlAbs: null })
    expect(r.totalPnlAbs).toBeNull()
  })

  it('non-USD, other-instrument, missing quote, missing cost basis: unmarkable with named reasons', () => {
    const r = markPlay([
      pos('eur', { currency: 'EUR' }),
      pos('oth', { instrument: 'other' }),
      pos('noq'),
      pos('noc', { cost_basis: null }),
    ], { eur: { price: 1 }, oth: { price: 1 }, noc: { price: 1 } })
    expect(r.positions.map((m) => m.reason)).toEqual(['non-usd', 'other-instrument', 'no-quote', 'no-cost-basis'])
    expect(r.unmarkedCount).toBe(4)
    expect(r.totalPnlAbs).toBeNull() // no partial fictions: nothing marked → no total
  })

  it('partial markability: total covers ONLY marked legs (caller sees the counts)', () => {
    const r = markPlay([
      pos('a', { quantity: 1, cost_basis: 350 }),
      pos('b', { realized: true }),
    ], { a: { price: 4 } })
    expect(r.totalPnlAbs).toBe(50) // 400 − 350
    expect(r.markedCount).toBe(1)
    expect(r.unmarkedCount).toBe(1)
  })
})

describe('markPlay: review round 1 tightenings', () => {
  it('PARTIAL coverage yields NO headline total — a spread with an unquotable short leg must not report the long leg alone', () => {
    const r = markPlay([
      pos('long', { strike: 150, cost_basis: 700, quantity: 2 }),
      pos('short', { strike: 160, side: 'short', cost_basis: 300, quantity: 2 }),
    ], { long: { price: 6 } }) // no quote for the short leg
    expect(r.positions[0]!.pnlAbs).toBe(500) // the per-leg mark still exists…
    expect(r.totalPnlAbs).toBeNull() // …but the total refuses the phantom +500
    expect(r.totalCostBasis).toBeNull()
    expect(r.markedCount).toBe(1)
    expect(r.unmarkedCount).toBe(1)
  })

  it('realized legs do NOT block the total (closed = final, not missing)', () => {
    const r = markPlay([
      pos('open', { quantity: 1, cost_basis: 350 }),
      pos('closed', { realized: true }),
    ], { open: { price: 4 } })
    expect(r.totalPnlAbs).toBe(50)
  })

  it('an option leg without strike+expiry is unmarkable even WITH a quote (no OCC symbol = fiction)', () => {
    const r = markPlay([pos('a', { strike: null })], { a: { price: 6 } })
    expect(r.positions[0]).toMatchObject({ markable: false, reason: 'incomplete-leg' })
    const r2 = markPlay([pos('b', { expiry: null })], { b: { price: 6 } })
    expect(r2.positions[0]!.reason).toBe('incomplete-leg')
    // Shares need no strike/expiry.
    const r3 = markPlay([pos('c', { instrument: 'shares', strike: null, expiry: null, quantity: 10, cost_basis: 1000 })], { c: { price: 120 } })
    expect(r3.positions[0]!.markable).toBe(true)
  })
})
