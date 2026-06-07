/**
 * Unit tests for the pure helpers hoisted to `@wsb/shared` in slice 8 — `prettyName` (ported from the
 * frozen oracle `wsb_signals/db.py:pretty_name`) and `compareBoard` (the canonical board total order the
 * worker and web both sort on). `compareBoard`'s total-order property is covered separately in
 * shadow.test.ts; here we pin the display formatting + the ordering chain.
 */
import { describe, expect, it } from 'vitest'

import { type BoardRow, compareBoard, prettyName } from '@wsb/shared'

// Expectations are the ACTUAL oracle outputs (verified by running wsb_signals.db.pretty_name), NOT the
// oracle's docstring — which misleadingly shows "Broadcom Inc." with a period. The suffix regex's leading
// `[,.]?` consumes the trailing "." of "Inc.", so the real output is "Broadcom Inc". We match the code.
describe('prettyName (oracle parity)', () => {
  it('title-cases and strips the security-type suffix (incl. the trailing period of "Inc.")', () => {
    expect(prettyName('BROADCOM INC. COMMON STOCK')).toBe('Broadcom Inc')
    expect(prettyName('APPLE INC. COMMON STOCK')).toBe('Apple Inc')
  })

  it('strips a Class-qualified Common Stock suffix', () => {
    expect(prettyName('ALPHABET INC. CLASS A COMMON STOCK')).toBe('Alphabet Inc')
    expect(prettyName('GAMESTOP CORP. CLASS A COMMON STOCK')).toBe('Gamestop Corp')
  })

  it('preserves an interior comma while stripping the suffix', () => {
    expect(prettyName('TESLA, INC. COMMON STOCK')).toBe('Tesla, Inc')
  })

  it('leaves ETF / non-suffixed names intact (just title-cased)', () => {
    expect(prettyName('SPDR S&P 500 ETF TRUST')).toBe('Spdr S&P 500 Etf Trust')
    expect(prettyName('NVIDIA CORPORATION')).toBe('Nvidia Corporation')
  })

  it('returns empty string for unknown names', () => {
    expect(prettyName(null)).toBe('')
    expect(prettyName(undefined)).toBe('')
    expect(prettyName('')).toBe('')
  })

  it('truncates with an ellipsis when maxLen is set', () => {
    expect(prettyName('BROADCOM INC. COMMON STOCK', 5)).toBe('Broa…')
  })
})

describe('compareBoard (canonical board order)', () => {
  const row = (hE: number, sov: number, authors: number, mentions: number, ticker: string): BoardRow =>
    ({ hE, sov, authors, mentions, ticker })

  it('orders by h_e desc, then sov, authors, mentions, then ticker asc', () => {
    const rows: BoardRow[] = [
      row(0.4, 0.2, 5, 10, 'ZZZ'),
      row(0.9, 0.5, 9, 30, 'AAA'),
      row(0.4, 0.2, 5, 10, 'AAA'), // identical to ZZZ row except ticker → must sort before it
      row(0.6, 0.3, 7, 20, 'MMM'),
    ]
    const sorted = [...rows].sort(compareBoard).map((r) => r.ticker)
    expect(sorted).toEqual(['AAA', 'MMM', 'AAA', 'ZZZ'])
  })
})
