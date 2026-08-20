import { describe, expect, it } from 'vitest'

import {
  deriveAnchor, derivePostedPnl, derivePrimaryTicker, deriveRealized,
} from '../src/plays/evidence'
import type { ValidatedPosition } from '../src/plays/validate'

// P3 pure derivations (plays-plan §5). The DB-touching evidence assembly (last-complete-window,
// staleness, herd exclusions) is covered on real Postgres in plays.it.test.ts.

const POST = 1_787_136_000 // 2026-08-19T10:40Z

const leg = (over: Partial<ValidatedPosition> = {}): ValidatedPosition => ({
  ticker: 'NVDA', instrument: 'call', side: 'long', quantity: 10, avg_price: 1,
  strike: 200, expiry: '2026-09-18', cost_basis: 1000, current_value: 2000,
  pnl_abs: 1000, pnl_pct: 100, realized: false, opened_at: null, currency: null,
  confidence: null, field_confidence: null,
  position_id: 'x', ticker_outcome: 'validated', arithmetic_ok: true,
  ...over,
})

describe('deriveAnchor (product §4.2 — evidence anchors at the entry, not the post)', () => {
  it('anchors at the end of the EARLIEST opened_at day (inside its last hour bucket), badged opened_at', () => {
    const a = deriveAnchor([
      leg({ opened_at: '2026-08-12' }), leg({ opened_at: '2026-08-10' }),
    ], POST)
    expect(a.basis).toBe('opened_at')
    // 23:59:59 of the 08-10 UTC day — NOT the next midnight, which would bucket one window over
    expect(a.utc).toBe(Date.parse('2026-08-11T00:00:00Z') / 1000 - 1)
  })

  it('never anchors after the post: a same-day open clamps to post time, still badged opened_at', () => {
    const a = deriveAnchor([leg({ opened_at: '2026-08-19' })], POST)
    expect(a).toEqual({ utc: POST, basis: 'opened_at' })
  })

  it('no opened_at → post time, badged as the weaker fallback', () => {
    expect(deriveAnchor([leg()], POST)).toEqual({ utc: POST, basis: 'post_time' })
  })

  it('a FUTURE opened_at (extraction misread) is ignored, not anchored on', () => {
    expect(deriveAnchor([leg({ opened_at: '2027-01-15' })], POST)).toEqual({ utc: POST, basis: 'post_time' })
  })
})

describe('derivePrimaryTicker (cost-weighted headline ticker)', () => {
  it('the biggest cost basis wins, not the most legs', () => {
    expect(derivePrimaryTicker([
      leg({ ticker: 'SPY', cost_basis: 50 }), leg({ ticker: 'SPY', cost_basis: 60 }),
      leg({ ticker: 'NVDA', cost_basis: 10_000 }),
    ])).toBe('NVDA')
  })

  it('all-null bases fall back to leg count; ties break by screen order', () => {
    expect(derivePrimaryTicker([
      leg({ ticker: 'AMD', cost_basis: null }),
      leg({ ticker: 'TSLA', cost_basis: null }), leg({ ticker: 'TSLA', cost_basis: null }),
    ])).toBe('TSLA')
    expect(derivePrimaryTicker([
      leg({ ticker: 'AMD', cost_basis: null }), leg({ ticker: 'TSLA', cost_basis: null }),
    ])).toBe('AMD')
    expect(derivePrimaryTicker([])).toBeNull()
  })
})

describe('derivePostedPnl (plan §5 board semantics — the screenshot IS the play’s content)', () => {
  it('sums pnl_abs across reporting legs; pct = Σpnl/Σbasis over legs carrying both', () => {
    const { pnlAbs, pnlPct } = derivePostedPnl([
      leg({ pnl_abs: 1000, cost_basis: 1000 }),
      leg({ pnl_abs: -500, cost_basis: 1000 }),
      leg({ pnl_abs: null, cost_basis: null, pnl_pct: null }),
    ])
    expect(pnlAbs).toBe(500)
    expect(pnlPct).toBe(25)
  })

  it('no abs/basis pairs but a single reported pct → that pct is the play’s', () => {
    const { pnlAbs, pnlPct } = derivePostedPnl([
      leg({ pnl_abs: null, cost_basis: null, pnl_pct: 420 }),
    ])
    expect(pnlAbs).toBeNull()
    expect(pnlPct).toBe(420)
  })

  it('nothing reported → nulls, never zeros (0 would read as break-even)', () => {
    expect(derivePostedPnl([leg({ pnl_abs: null, cost_basis: null, pnl_pct: null })]))
      .toEqual({ pnlAbs: null, pnlPct: null })
  })

  it('mixed currencies never sum (a CAD leg + a USD leg is not a dollar total); null ≡ USD', () => {
    expect(derivePostedPnl([
      leg({ pnl_abs: 1000, cost_basis: 1000, currency: 'CAD' }),
      leg({ pnl_abs: 500, cost_basis: 1000, currency: null }),
    ])).toEqual({ pnlAbs: null, pnlPct: null })
    // explicit USD + null-USD still aggregate — same currency by convention
    expect(derivePostedPnl([
      leg({ pnl_abs: 1000, cost_basis: 1000, currency: 'USD' }),
      leg({ pnl_abs: 500, cost_basis: 1000, currency: null }),
    ])).toEqual({ pnlAbs: 1500, pnlPct: 75 })
  })
})

describe('deriveRealized (board flag; false = still open = what P5 tracks)', () => {
  it('any open leg → false; all closed → true; unknown → null', () => {
    expect(deriveRealized([leg({ realized: true }), leg({ realized: false })])).toBe(false)
    expect(deriveRealized([leg({ realized: true }), leg({ realized: true })])).toBe(true)
    expect(deriveRealized([leg({ realized: null })])).toBeNull()
    expect(deriveRealized([])).toBeNull()
  })
})
