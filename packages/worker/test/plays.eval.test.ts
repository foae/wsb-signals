import { describe, expect, it } from 'vitest'

import type { LlmExtraction } from '../src/plays/extraction'
import { fieldMatches, scoreCase, summarize } from '../src/plays/eval'
import { leg } from './plays.extraction.test'

// The eval scorer (P2, plays-plan §4) — mechanical scoring is what makes the harness repeatable
// across model swaps. The LLM path itself is exercised manually (paid calls, a gate not CI).

const extraction = (positions: LlmExtraction['positions']): LlmExtraction => ({
  screenshot_kind: 'single_position', broker: null, positions, notes: null, confidence: null,
})

describe('fieldMatches', () => {
  it('a correct null scores as correct; null-vs-value does not', () => {
    expect(fieldMatches(null, null)).toBe(true)
    expect(fieldMatches(null, 5)).toBe(false)
    expect(fieldMatches(5, null)).toBe(false)
  })
  it('numbers tolerate 0.5 % broker rounding, no more', () => {
    expect(fieldMatches(700, 700.5)).toBe(true)
    expect(fieldMatches(700, 707)).toBe(false)
  })
  it('strings/enums are exact', () => {
    expect(fieldMatches('long', 'long')).toBe(true)
    expect(fieldMatches('long', 'short')).toBe(false)
  })
})

describe('scoreCase', () => {
  it('perfect extraction scores every field', () => {
    const s = scoreCase('c1', extraction([leg()]), extraction([leg()]))
    expect(s.perField.ticker).toEqual({ correct: 1, total: 1 })
    expect(s.perField.expiry).toEqual({ correct: 1, total: 1 })
    expect(s.kindOk).toBe(true)
  })
  it('a missing position counts EVERY field wrong — under-extraction cannot inflate accuracy', () => {
    const s = scoreCase('c2', extraction([leg(), leg({ side: 'short' })]), extraction([leg()]))
    expect(s.perField.ticker).toEqual({ correct: 1, total: 2 })
    expect(s.positionsExpected).toBe(2)
    expect(s.positionsActual).toBe(1)
  })
  it('field errors land on their field only', () => {
    const s = scoreCase('c3', extraction([leg()]), extraction([leg({ expiry: '2026-10-16' })]))
    expect(s.perField.expiry.correct).toBe(0)
    expect(s.perField.ticker.correct).toBe(1)
  })
})

describe('summarize', () => {
  it('reports per-field percentages and flags the marking-critical fields', () => {
    const s = summarize([scoreCase('c1', extraction([leg()]), extraction([leg()]))])
    expect(s.ticker).toContain('100.0%')
    expect(s.ticker).toContain('MARKING-CRITICAL')
    expect(s.avg_price).not.toContain('MARKING-CRITICAL')
    expect(s.position_count).toContain('100.0%')
  })
})
