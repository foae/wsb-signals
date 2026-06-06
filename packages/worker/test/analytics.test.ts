import { describe, expect, it } from 'vitest'

import {
  classifyQuadrant, divergence, leadLagHours, median, pearson, type LeadLagConfig, type SeriesPoint,
} from '../src/analytics'

// Slice 7 is NEW (no Python oracle — the frozen radar never populated `signals`), so the pure signal math
// is gated by THESE tests, not parity fixtures. They pin the design semantics in design/v2-porting-spec.md §11.

describe('median', () => {
  it('odd length → middle; even → mean of the two middles; empty → null', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
    expect(median([5])).toBe(5)
    expect(median([])).toBeNull()
  })
  it('does not mutate the input', () => {
    const xs = [3, 1, 2]
    median(xs)
    expect(xs).toEqual([3, 1, 2])
  })
})

describe('divergence', () => {
  it('is signed H_e − H_m', () => {
    expect(divergence(0.7, 0.2)).toBeCloseTo(0.5, 12)
    expect(divergence(0.2, 0.7)).toBeCloseTo(-0.5, 12)
    expect(divergence(0.4, 0.4)).toBe(0)
  })
})

describe('classifyQuadrant (strictly-above-median = hot)', () => {
  it('maps the four cells', () => {
    expect(classifyQuadrant(0.8, 0.8, 0.5, 0.5)).toBe('CONFIRMED')
    expect(classifyQuadrant(0.8, 0.2, 0.5, 0.5)).toBe('HYPE')
    expect(classifyQuadrant(0.2, 0.8, 0.5, 0.5)).toBe('STEALTH')
    expect(classifyQuadrant(0.2, 0.2, 0.5, 0.5)).toBe('QUIET')
  })
  it('a value exactly ON the median is the QUIET side (must clear the bar)', () => {
    expect(classifyQuadrant(0.5, 0.8, 0.5, 0.5)).toBe('STEALTH') // H_e == thr → not hot
    expect(classifyQuadrant(0.8, 0.5, 0.5, 0.5)).toBe('HYPE') // H_m == thr → not hot
    expect(classifyQuadrant(0.5, 0.5, 0.5, 0.5)).toBe('QUIET') // both on the line
  })
})

describe('pearson', () => {
  it('±1 for perfectly (anti)correlated samples', () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12)
    expect(pearson([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1, 12)
  })
  it('null when a side is constant or there are <2 points', () => {
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull()
    expect(pearson([5], [5])).toBeNull()
    expect(pearson([1, 2], [1])).toBeNull() // length mismatch
  })
})

describe('leadLagHours', () => {
  const PI = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9, 3] // distinctive, low self-correlation off lag 0
  const W = 3600
  const BASE = 1_700_000_000
  const cfg: LeadLagConfig = { lookbackSeconds: 7 * 24 * 3600, maxLagWindows: 6, minPairs: 4, minCorr: 0.3 }

  /** Build a series where H_m(t) = H_e(t − shift): H_e leads H_m by `shift` windows (shift>0 ⇒ WSB leads). */
  const shifted = (shift: number): SeriesPoint[] =>
    PI.map((v, k) => ({
      windowStart: BASE + k * W,
      hE: v,
      hM: k - shift >= 0 && k - shift < PI.length ? PI[k - shift]! : null,
    }))

  it('detects H_e leading H_m by +2 windows → +2h', () => {
    expect(leadLagHours(shifted(2), W, cfg)).toBeCloseTo(2, 12)
  })
  it('detects the market leading (H_e lags) → −2h', () => {
    // mirror: H_e(t) = H_m(t − 2) ⇒ H_m is the early series ⇒ negative lead-lag
    const s = PI.map((v, k) => ({
      windowStart: BASE + k * W,
      hM: v,
      hE: k - 2 >= 0 ? PI[k - 2]! : null,
    }))
    expect(leadLagHours(s, W, cfg)).toBeCloseTo(-2, 12)
  })
  it('null when fewer than minPairs overlap', () => {
    const tiny = shifted(2).slice(0, 3)
    expect(leadLagHours(tiny, W, cfg)).toBeNull()
  })
  it('null when a series is flat (no correlation defined)', () => {
    const flat = PI.map((_, k) => ({ windowStart: BASE + k * W, hE: 1, hM: 1 }))
    expect(leadLagHours(flat, W, cfg)).toBeNull()
  })
  it('null when the peak correlation does not clear minCorr', () => {
    expect(leadLagHours(shifted(2), W, { ...cfg, minCorr: 1.1 })).toBeNull() // unreachable threshold
  })
  it('handles gaps (missing windows) on the regular grid', () => {
    const withGap = shifted(2).filter((p) => (p.windowStart - BASE) / W !== 5) // drop window index 5
    expect(leadLagHours(withGap, W, cfg)).toBeCloseTo(2, 12)
  })
})
