import { describe, expect, it } from 'vitest'

import { readCliArg, summarizeHeatCalibration, type HeatCalibrationPoint } from '../src/heat-calibrate'

const point = (windowStart: number, ticker: string, over: Partial<HeatCalibrationPoint> = {}): HeatCalibrationPoint => ({
  windowStart, ticker, capped: false, scoringVersion: 'heat-v', authors: 4,
  hE: 0.5, hM: 0.4, divergence: 0.1, quadrant: 'CONFIRMED', rank: 1, ...over,
})

describe('heat calibration summary', () => {
  it('reports coverage, thin-row violations, versions, distributions, and top-list stability', () => {
    const summary = summarizeHeatCalibration([
      point(0, 'A', { hE: 0.2, rank: 1 }),
      point(0, 'B', { authors: 1, quadrant: null, hM: null, divergence: null, rank: 2 }),
      point(3600, 'A', { hE: 0.8, rank: 1, capped: true }),
      point(3600, 'C', { authors: 1, quadrant: 'HYPE', rank: 2, capped: true }),
    ])

    expect(summary).toMatchObject({
      windows: 2,
      rows: 4,
      cappedWindows: 1,
      scoringVersions: { 'heat-v': 2 },
      coverage: { market: 0.75, quadrant: 0.75, thinRows: 0.5, thinRowsWithQuadrant: 1 },
    })
    expect(summary.distributions.hE.p10).toBeCloseTo(0.29, 12)
    expect(summary.distributions.hE.p50).toBeCloseTo(0.5, 12)
    expect(summary.distributions.hE.p90).toBeCloseTo(0.71, 12)
    expect(summary.meanTop10Jaccard).toBeCloseTo(1 / 3, 12)
  })

  it('accepts separated and equals-form ranges without silent fallback', () => {
    expect(readCliArg(['--from', '2026-08-01'], '--from')).toBe('2026-08-01')
    expect(readCliArg(['--from=2026-08-01'], '--from')).toBe('2026-08-01')
    expect(readCliArg([], '--from')).toBeUndefined()
    expect(() => readCliArg(['--from='], '--from')).toThrow('--from requires a value')
    expect(() => readCliArg(['--from', '--to', '1'], '--from')).toThrow('--from requires a value')
  })
})
