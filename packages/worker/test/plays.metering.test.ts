import { describe, expect, it } from 'vitest'

import type { PlaysLlmConfig } from '../src/config'
import { costUsd, estimateInputTokens, usablePrices } from '../src/plays/metering'

// Fail-closed metering (invariant P6, plays-plan §4). The DB-backed pieces (todaySpendUsd summing,
// the restart-proof budget, canDispatch against real rows) are pinned in plays.it.test.ts — the
// P2 gate requires the all-zero-price and restart cases proven by test.

const llm = (prices: PlaysLlmConfig['prices']): PlaysLlmConfig => ({
  provider: 'openai', extractModel: 'm', interpretModel: 'm', maxPlaysPerTick: 5,
  maxOutputTokens: 2000, dailyBudgetUsd: 5, prices,
})

describe('usablePrices (fail closed — zero/missing NEVER means free)', () => {
  it('returns the prices only when both sides are positive', () => {
    expect(usablePrices(llm({ m: { input: 0.25, output: 2 } }), 'm')).toEqual({ input: 0.25, output: 2 })
  })
  it('the shipped 0.0 placeholders refuse', () => {
    expect(usablePrices(llm({ m: { input: 0, output: 0 } }), 'm')).toBeNull()
  })
  it('one-sided zero refuses (a $0 output meter still under-counts)', () => {
    expect(usablePrices(llm({ m: { input: 0.25, output: 0 } }), 'm')).toBeNull()
    expect(usablePrices(llm({ m: { input: 0, output: 2 } }), 'm')).toBeNull()
  })
  it('a model absent from [plays.llm.prices] refuses', () => {
    expect(usablePrices(llm({ other: { input: 1, output: 1 } }), 'm')).toBeNull()
  })
  it('NaN/negative garbage refuses', () => {
    expect(usablePrices(llm({ m: { input: NaN, output: 2 } }), 'm')).toBeNull()
    expect(usablePrices(llm({ m: { input: -1, output: 2 } }), 'm')).toBeNull()
  })
})

describe('costUsd', () => {
  it('$/Mtok both directions', () => {
    // 100k in @ $0.25/M + 2k out @ $2/M = $0.025 + $0.004
    expect(costUsd({ input: 0.25, output: 2 }, 100_000, 2_000)).toBeCloseTo(0.029, 9)
  })
})

describe('estimateInputTokens (conservative pre-dispatch reservation)', () => {
  it('scales with images and text, never zero (the system prompt is always sent)', () => {
    const none = estimateInputTokens(0, 0)
    expect(none).toBeGreaterThan(500)
    expect(estimateInputTokens(3, 0) - none).toBeGreaterThanOrEqual(3 * 1000)
    expect(estimateInputTokens(0, 4000) - none).toBe(1000)
  })
})
