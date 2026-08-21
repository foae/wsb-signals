/** Offline calibration diagnostics over finalized heat windows; never computes ticker win rates. */
import { cycleRuns, empiricalFeatures, signals } from '@wsb/shared'
import { and, asc, eq, gte, isNotNull, lt } from 'drizzle-orm'

import { createDb } from './db'

export interface HeatCalibrationPoint {
  windowStart: number
  capped: boolean | null
  scoringVersion: string | null
  ticker: string
  authors: number | null
  hE: number | null
  hM: number | null
  divergence: number | null
  quadrant: string | null
  rank: number | null
}

function quantile(values: number[], q: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const at = (sorted.length - 1) * q
  const lo = Math.floor(at)
  const hi = Math.ceil(at)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo)
}

function distribution(values: Array<number | null>): { p10: number | null; p50: number | null; p90: number | null } {
  const present = values.flatMap((value) => value == null ? [] : [value])
  return { p10: quantile(present, 0.1), p50: quantile(present, 0.5), p90: quantile(present, 0.9) }
}

export function summarizeHeatCalibration(points: readonly HeatCalibrationPoint[], minRowAuthors = 3) {
  const windows = new Map<number, HeatCalibrationPoint[]>()
  for (const point of points) {
    const rows = windows.get(point.windowStart) ?? []
    rows.push(point)
    windows.set(point.windowStart, rows)
  }
  const orderedWindows = [...windows.entries()].sort(([a], [b]) => a - b)
  const overlaps: number[] = []
  for (let i = 1; i < orderedWindows.length; i++) {
    const prior = new Set(orderedWindows[i - 1]![1]
      .filter((row) => (row.rank ?? Infinity) <= 10).map((row) => row.ticker))
    const current = new Set(orderedWindows[i]![1]
      .filter((row) => (row.rank ?? Infinity) <= 10).map((row) => row.ticker))
    const union = new Set([...prior, ...current])
    if (union.size) overlaps.push([...prior].filter((ticker) => current.has(ticker)).length / union.size)
  }

  const versions = new Map<string, number>()
  for (const [, rows] of orderedWindows) {
    const version = rows[0]?.scoringVersion ?? 'unversioned'
    versions.set(version, (versions.get(version) ?? 0) + 1)
  }
  const thin = points.filter((point) => (point.authors ?? 0) < minRowAuthors)
  const withMarket = points.filter((point) => point.hM != null)
  const withQuadrant = points.filter((point) => point.quadrant != null)
  const cappedWindows = orderedWindows.filter(([, rows]) => rows[0]?.capped === true).length

  return {
    windows: orderedWindows.length,
    rows: points.length,
    cappedWindows,
    scoringVersions: Object.fromEntries([...versions.entries()].sort(([a], [b]) => a.localeCompare(b))),
    coverage: {
      market: points.length ? withMarket.length / points.length : 0,
      quadrant: points.length ? withQuadrant.length / points.length : 0,
      thinRows: points.length ? thin.length / points.length : 0,
      thinRowsWithQuadrant: thin.filter((point) => point.quadrant != null).length,
    },
    distributions: {
      hE: distribution(points.map((point) => point.hE)),
      hM: distribution(points.map((point) => point.hM)),
      divergence: distribution(points.map((point) => point.divergence)),
    },
    meanTop10Jaccard: overlaps.length
      ? overlaps.reduce((sum, value) => sum + value, 0) / overlaps.length
      : null,
  }
}

function epoch(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return Math.floor(numeric)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`invalid date/epoch: ${value}`)
  return Math.floor(parsed / 1000)
}

export function readCliArg(args: readonly string[], name: string): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!
    if (value === name) {
      const next = args[index + 1]
      if (!next || next.startsWith('--')) throw new Error(`${name} requires a value`)
      return next
    }
    if (value.startsWith(`${name}=`)) {
      const inline = value.slice(name.length + 1)
      if (!inline) throw new Error(`${name} requires a value`)
      return inline
    }
  }
  return undefined
}

async function main(): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  const args = process.argv.slice(2)
  const from = epoch(readCliArg(args, '--from'), now - 30 * 86_400)
  const to = epoch(readCliArg(args, '--to'), now)
  if (from >= to) throw new Error('--from must be before --to')
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')
  const handle = createDb(url, { max: 2 })
  try {
    const rows = await handle.db.select({
      windowStart: cycleRuns.windowStart,
      capped: cycleRuns.capped,
      scoringVersion: cycleRuns.scoringVersion,
      ticker: empiricalFeatures.ticker,
      authors: empiricalFeatures.authors,
      hE: empiricalFeatures.hE,
      hM: signals.hM,
      divergence: signals.divergence,
      quadrant: signals.quadrant,
      rank: signals.rank,
    }).from(cycleRuns)
      .innerJoin(empiricalFeatures, eq(empiricalFeatures.windowStart, cycleRuns.windowStart))
      .leftJoin(signals, and(
        eq(signals.windowStart, empiricalFeatures.windowStart),
        eq(signals.ticker, empiricalFeatures.ticker),
      ))
      .where(and(
        eq(cycleRuns.status, 'complete'),
        isNotNull(cycleRuns.finalizedAt),
        gte(cycleRuns.windowStart, from),
        lt(cycleRuns.windowStart, to),
      ))
      .orderBy(asc(cycleRuns.windowStart), asc(signals.rank))
    process.stdout.write(`${JSON.stringify({ range: { from, to }, ...summarizeHeatCalibration(rows) }, null, 2)}\n`)
  } finally {
    await handle.close()
  }
}

if (process.argv[1]?.endsWith('heat-calibrate.ts') || process.argv[1]?.endsWith('heat-calibrate.js')) {
  main().catch((error) => {
    process.stderr.write(`heat-calibrate: ${String(error)}\n`)
    process.exitCode = 1
  })
}
