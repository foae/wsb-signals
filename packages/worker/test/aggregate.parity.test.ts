import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { aggregateWindow, type AggregateInputs, type HistoryRow, type MentionRow } from '../src/aggregate'

// Slice-2 parity gate: the ported aggregator must reproduce the frozen v0.0.1 oracle's EmpiricalFeature
// list — VALUES and ORDER — for the hand-built scenarios AND 30 seeded RANDOM scenarios (the adversarial
// property-parity from v2-porting-spec.md §9: varied weekdays, tie-dense boards exercising the quantized
// sort, cold/warming/ready baselines, and a non-zero z weight). Each fixture carries the exact DB reads
// aggregate_window consumed, so this runs DB-free.
interface FeatureRow {
  ticker: string
  window_start: number
  mentions: number
  authors: number
  sov: number
  velocity: number | null
  accel: number | null
  z: number | null
  net_dir: number
  dd_count: number
  flair_counts: string
  baseline_status: string
  h_e: number
}

interface AggFixture {
  name: string
  inputs: {
    window_start: number
    window_seconds: number
    weights: AggregateInputs['weights']
    min_samples_ready: number
    min_authors_full: number
    mentions_in_window: MentionRow[]
    prior_features: AggregateInputs['priorFeatures']
    prior_sov_ranks: Record<string, number>
    feature_history: HistoryRow[]
  }
  features: FeatureRow[]
}

const NAMED = ['basic_with_prior', 'cold_start', 'baseline_ready'] as const
const RANDOM_DIR = fileURLToPath(new URL('../../../fixtures/aggregate/random/', import.meta.url))
const RANDOM = readdirSync(RANDOM_DIR).filter((f) => f.endsWith('.json')).sort()
  .map((f) => `random/${f.replace('.json', '')}`)

function load(name: string): AggFixture {
  return JSON.parse(readFileSync(new URL(`../../../fixtures/aggregate/${name}.json`, import.meta.url), 'utf8'))
}

function inputsFrom(fx: AggFixture): AggregateInputs {
  const i = fx.inputs
  return {
    windowStart: i.window_start,
    windowSeconds: i.window_seconds,
    weights: i.weights,
    minSamplesReady: i.min_samples_ready,
    minAuthorsFull: i.min_authors_full,
    mentionsInWindow: i.mentions_in_window,
    priorFeatures: i.prior_features,
    priorSovRanks: i.prior_sov_ranks,
    featureHistory: i.feature_history,
  }
}

// Floats compared within tolerance; nulls must match exactly (null-vs-value is a contract, not noise).
function expectCloseOrNull(actual: number | null, expected: number | null, label: string): void {
  if (expected === null) expect(actual, label).toBeNull()
  else {
    expect(actual, label).not.toBeNull()
    expect(actual as number, label).toBeCloseTo(expected, 9)
  }
}

function assertParity(fx: AggFixture): void {
  const out = aggregateWindow(inputsFrom(fx))
  // ORDER is part of the contract — assert the full board sequence first.
  expect(out.map((r) => r.ticker), `${fx.name} order`).toEqual(fx.features.map((f) => f.ticker))
  expect(out, `${fx.name} length`).toHaveLength(fx.features.length)
  fx.features.forEach((exp, idx) => {
    const act = out[idx]!
    const at = `${fx.name}[${idx}] ${exp.ticker}`
    expect(act.ticker, `${at}.ticker`).toBe(exp.ticker)
    expect(act.windowStart, `${at}.windowStart`).toBe(exp.window_start)
    expect(act.mentions, `${at}.mentions`).toBe(exp.mentions)
    expect(act.authors, `${at}.authors`).toBe(exp.authors)
    expect(act.ddCount, `${at}.ddCount`).toBe(exp.dd_count)
    expect(act.baselineStatus, `${at}.baselineStatus`).toBe(exp.baseline_status)
    // flair_counts is a sorted json STRING in the oracle; v2 keeps it as a JSONB object — parity is on
    // the parsed counts, not the serialization.
    expect(act.flairCounts, `${at}.flairCounts`).toEqual(JSON.parse(exp.flair_counts))
    expectCloseOrNull(act.sov, exp.sov, `${at}.sov`)
    expectCloseOrNull(act.netDir, exp.net_dir, `${at}.netDir`)
    expectCloseOrNull(act.hE, exp.h_e, `${at}.hE`)
    expectCloseOrNull(act.velocity, exp.velocity, `${at}.velocity`)
    expectCloseOrNull(act.accel, exp.accel, `${at}.accel`)
    expectCloseOrNull(act.z, exp.z, `${at}.z`)
  })
}

describe('aggregate H_e parity (B4)', () => {
  for (const name of NAMED) {
    it(`${name} matches the oracle (values + order)`, () => assertParity(load(name)))
  }

  describe('randomized adversarial scenarios (seeded oracle)', () => {
    it.each(RANDOM)('%s matches the oracle (values + order)', (name) => assertParity(load(name)))
  })
})
