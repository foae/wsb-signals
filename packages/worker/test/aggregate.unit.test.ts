import { describe, expect, it } from 'vitest'

import {
  aggregateWindow,
  hourOfWeek,
  maxNorm,
  windowStartFor,
  type AggregateInputs,
  type HeatWeights,
  type MentionRow,
} from '../src/aggregate'

// Port of tests/test_aggregate.py to the pure-function signature (porting-spec: guard-tests-before-code).
// The Python original drove a DuckDB; here the four DB reads are explicit inputs. Snapshot tests
// (quiet/capped) are intentionally NOT ported — write_snapshot is a v0.0.1 presentation artifact,
// deferred (the v2 publish marker is built in slice 3).
const WINDOW = 3600
const WS = 3600 // current window [3600, 7200); prior features are keyed by ticker, not window
const WEIGHTS: HeatWeights = {
  sov: 0.35, accel: 0.15, rank_delta: 0.15, authors: 0.15, conviction: 0.1, net_dir: 0.1, z: 0.0,
}

function mention(ticker: string, thingId: string, author: string,
  opts: { ttype?: string; direction?: string } = {}): MentionRow {
  return [ticker, thingId, opts.ttype ?? 'comment', author, null, opts.direction ?? 'neutral']
}

function agg(partial: Partial<AggregateInputs> = {}) {
  const inp: AggregateInputs = {
    windowStart: WS,
    windowSeconds: WINDOW,
    weights: WEIGHTS,
    minSamplesReady: 8,
    minAuthorsFull: 1, // aggregate_window's default
    mentionsInWindow: [],
    priorFeatures: {},
    priorSovRanks: {},
    featureHistory: [],
    ...partial,
  }
  return aggregateWindow(inp)
}

describe('maxNorm', () => {
  it('scales by the window max', () => {
    expect(maxNorm([1, 2, 4])).toEqual([0.25, 0.5, 1])
  })
  it('floors negatives and handles all-zero / empty', () => {
    expect(maxNorm([-3, 0, 6])).toEqual([0, 0, 1])
    expect(maxNorm([0, 0])).toEqual([0, 0])
    expect(maxNorm([])).toEqual([])
  })
})

describe('window helpers', () => {
  it('window_start is clock-aligned', () => {
    expect(windowStartFor(7250, 3600)).toBe(7200)
  })
  it('hour_of_week is in [0,168)', () => {
    const h = hourOfWeek(WS)
    expect(h).toBeGreaterThanOrEqual(0)
    expect(h).toBeLessThan(168)
  })
  // The weekday remap (Python tm_wday Mon=0 vs JS getUTCDay Sun=0) is only load-bearing off Monday —
  // table-drive it across the week, especially Sunday (getUTCDay()=0 must map to bucket 144+).
  it.each([
    ['Mon 2024-01-01 00:00', 1_704_067_200, 0],
    ['Mon 2024-01-01 13:00', 1_704_067_200 + 13 * 3600, 13],
    ['Tue 2024-01-02 00:00', 1_704_153_600, 24],
    ['Sat 2024-01-06 00:00', 1_704_499_200, 120],
    ['Sun 2024-01-07 00:00', 1_704_585_600, 144], // getUTCDay()=0 → must remap to 6
    ['Sun 2024-01-07 23:00', 1_704_585_600 + 23 * 3600, 167],
  ])('hour_of_week(%s) = %i', (_label, epoch, expected) => {
    expect(hourOfWeek(epoch)).toBe(expected)
  })
})

describe('baseline status branches', () => {
  // History entries in the SAME hour-of-week bucket as W (168h apart) feed the z baseline.
  function sameBucketHistory(ticker: string, mentionsList: number[]) {
    return mentionsList.map((m, k): [string, number, number] => [ticker, WS - 168 * 3600 * (k + 1), m])
  }

  it('warming when 0 < samples < threshold (no z yet)', () => {
    const rows = agg({
      minSamplesReady: 8,
      mentionsInWindow: [mention('NVDA', 'c1', 'a'), mention('NVDA', 'c2', 'b')],
      featureHistory: sameBucketHistory('NVDA', [3, 5, 2]), // 3 samples < 8
    })
    expect(rows[0]!.baselineStatus).toBe('warming')
    expect(rows[0]!.z).toBeNull()
  })

  it('the max(2, minSamplesReady) guard never lets a single sample be ready', () => {
    const warming = agg({
      minSamplesReady: 1, // misconfigured low — guard raises the floor to 2
      mentionsInWindow: [mention('NVDA', 'c1', 'a')],
      featureHistory: sameBucketHistory('NVDA', [4]), // 1 sample
    })
    expect(warming[0]!.baselineStatus).toBe('warming') // not ready (would divide by n-1=0)
    const ready = agg({
      minSamplesReady: 1,
      mentionsInWindow: [mention('NVDA', 'c1', 'a')],
      featureHistory: sameBucketHistory('NVDA', [4, 6]), // 2 samples ≥ max(2,1)
    })
    expect(ready[0]!.baselineStatus).toBe('ready')
  })

  it('ready but zero-variance baseline → z null (sd == 0)', () => {
    const rows = agg({
      minSamplesReady: 8,
      mentionsInWindow: [mention('NVDA', 'c1', 'a')],
      featureHistory: sameBucketHistory('NVDA', [5, 5, 5, 5, 5, 5, 5, 5]), // all identical → sd 0
    })
    expect(rows[0]!.baselineStatus).toBe('ready')
    expect(rows[0]!.z).toBeNull()
  })
})

describe('prior-window momentum guard', () => {
  it('no prior window → null velocity/accel (a gap is not a breakout)', () => {
    const rows = agg({ mentionsInWindow: [mention('NVDA', 'c1', 'alice'), mention('NVDA', 'c2', 'bob')] })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.velocity).toBeNull()
    expect(rows[0]!.accel).toBeNull()
  })

  it('prior window present → velocity = m − m_prev, accel = velocity − velocity_prev', () => {
    const rows = agg({
      priorFeatures: { NVDA: { mentions: 2, velocity: 1 } },
      mentionsInWindow: [0, 1, 2, 3, 4].map((i) => mention('NVDA', `c${i}`, `u${i}`)), // m = 5
    })
    expect(rows[0]!.velocity).toBeCloseTo(3, 12) // 5 − 2
    expect(rows[0]!.accel).toBeCloseTo(2, 12) // 3 − 1
  })

  it('new arrival in an existing prior window → velocity = m, accel null', () => {
    const rows = agg({
      priorFeatures: { AMD: { mentions: 4, velocity: 1 } }, // prior exists, but for another ticker
      mentionsInWindow: [0, 1, 2].map((i) => mention('NVDA', `c${i}`, `u${i}`)), // m = 3
    })
    const nvda = rows.find((r) => r.ticker === 'NVDA')!
    expect(nvda.velocity).toBeCloseTo(3, 12)
    expect(nvda.accel).toBeNull()
  })
})

describe('SoV denominator + per-thing dedup', () => {
  it('shares of voice sum over distinct (ticker, thing) cells', () => {
    const rows = agg({
      mentionsInWindow: [
        ...[0, 1, 2].map((i) => mention('AAA', `a${i}`, `u${i}`)),
        ...[0, 1].map((i) => mention('BBB', `b${i}`, `u${i}`)),
      ],
    })
    const by = Object.fromEntries(rows.map((r) => [r.ticker, r]))
    expect(by.AAA!.mentions).toBe(3)
    expect(by.AAA!.sov).toBeCloseTo(0.6, 12)
    expect(by.BBB!.mentions).toBe(2)
    expect(by.BBB!.sov).toBeCloseTo(0.4, 12)
  })

  it('dedups repeated (ticker, thingId)', () => {
    const rows = agg({
      mentionsInWindow: [mention('AAA', 'x1', 'u1'), mention('AAA', 'x1', 'u2')], // same thing → 1
    })
    expect(rows[0]!.mentions).toBe(1)
  })
})

describe('support damping', () => {
  function singleTickerHE(nAuthors: number, minAuthorsFull: number): number {
    const rows = agg({
      minAuthorsFull,
      mentionsInWindow: Array.from({ length: nAuthors }, (_, i) => mention('XYZ', `t${i}`, `author${i}`)),
    })
    return rows[0]!.hE
  }

  it('thin-support rows are damped toward zero (1 author ⇒ ⅓ of full)', () => {
    const full = singleTickerHE(3, 3) // damp = 1.0
    const thin = singleTickerHE(1, 3) // damp = 1/3
    expect(full).toBeCloseTo(0.5, 12) // 0.35 (sov) + 0.15 (authors); accel None, neutral
    expect(thin).toBeCloseTo(full / 3, 12)
  })
})

describe('deterministic ranking (canonical tie-break)', () => {
  function board(order: string[]): string[] {
    const mentions = order.flatMap((tk) => [mention(tk, `${tk}1`, 'ua'), mention(tk, `${tk}2`, 'ub')])
    return agg({ mentionsInWindow: mentions }).map((r) => r.ticker)
  }

  it('equal-scored tickers order by ticker asc, independent of input order', () => {
    expect(board(['CCC', 'AAA', 'BBB'])).toEqual(['AAA', 'BBB', 'CCC'])
    expect(board(['BBB', 'CCC', 'AAA'])).toEqual(['AAA', 'BBB', 'CCC'])
  })
})
