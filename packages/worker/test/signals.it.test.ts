import {
  analyticalFeatures, cycleRuns, empiricalFeatures, signals as signalsTable,
  type AnalyticalFeatureInsert, type EmpiricalFeatureInsert,
} from '@wsb/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { EmpiricalFeature } from '../src/aggregate'
import type { SignalsConfig } from '../src/analytics'
import { publishCycle } from '../src/db'
import { buildSignals, repairFinalizedSignalDrift } from '../src/pipeline'
import { startPg, type PgHarness } from './helpers/pg'

// Slice 7 integration (NEW, no oracle): drive buildSignals on real Postgres — exercising the empirical⋈
// analytical median read, the H_e-rank read, the per-ticker series read for lead-lag, and the atomic
// publish of `signals`. The pure math is covered in analytics.test.ts; here we prove the WIRING.

const W = 1_704_070_800
const WS = 3600
const cfg: SignalsConfig = {
  medianLookbackSeconds: 7 * 24 * 3600,
  minQuadrantPopulation: 2, // low so the small seeded worlds still get quadrants
  minRowAuthors: 1,
  leadLag: { enabled: false, lookbackSeconds: 7 * 24 * 3600, maxLagWindows: 6, minPairs: 6, minCorr: 0.3 },
}

/** A minimal EmpiricalFeature (the in-memory current board buildSignals consumes; rows must be sorted). */
const ef = (ticker: string, hE: number, over: Partial<EmpiricalFeature> = {}): EmpiricalFeature => ({
  ticker, windowStart: W, mentions: 1, authors: 1, sov: hE, velocity: null, accel: null, z: null,
  netDir: 0, ddCount: 0, flairCounts: {}, baselineStatus: 'cold', hE, ...over,
})
const ana = (ticker: string, hM: number, windowStart = W): AnalyticalFeatureInsert =>
  ({ ticker, windowStart, ret: null, rvol: null, rvolConf: 'low', hM })
const emp = (ticker: string, windowStart: number, hE: number): EmpiricalFeatureInsert =>
  ({ ticker, windowStart, mentions: 1, authors: 1, sov: hE, hE })
const meta = (totalMentions: number) => ({
  windowStart: W, scoringVersion: 'test-heat', generatedAt: W + 1,
  totalMentions, quiet: false, capped: false,
  newestUtc: W, newestPostUtc: W, newestCommentUtc: W,
  marketStatus: 'fresh' as const, marketRequested: 4, marketUsable: 4, marketAsOf: W,
})

let pg: PgHarness
beforeAll(async () => { pg = await startPg() })
afterAll(async () => { await pg?.stop() })
beforeEach(async () => { await pg.reset() })

describe('buildSignals — divergence / quadrant / rank', () => {
  it('classifies the four quadrants off the global median, with divergence + rank + rank_delta', async () => {
    // Prior window's H_e leaderboard → rank_delta. (ranks: B=1, A=2, C=3)
    await pg.db.insert(empiricalFeatures).values([
      emp('B', W - WS, 0.9), emp('A', W - WS, 0.8), emp('C', W - WS, 0.7),
    ])

    // Current board (sorted by H_e desc): A .9, B .8, D .5(un-overlaid), C .2, E .1
    const rows = [ef('A', 0.9), ef('B', 0.8), ef('D', 0.5), ef('C', 0.2), ef('E', 0.1)]
    // Overlay 4 of them; D is NOT priced. Overlaid H_e=[.9,.8,.2,.1]→median .5; H_m=[.9,.2,.8,.1]→median .5.
    const fresh = [ana('A', 0.9), ana('B', 0.2), ana('C', 0.8), ana('E', 0.1)]

    const out = await buildSignals(pg.db, W, WS, cfg, rows, fresh)
    const by = new Map(out.map((s) => [s.ticker, s]))

    // quadrants off thr (0.5, 0.5)
    expect(by.get('A')!.quadrant).toBe('CONFIRMED') // hot/hot
    expect(by.get('B')!.quadrant).toBe('HYPE') //      hot/quiet
    expect(by.get('C')!.quadrant).toBe('STEALTH') //   quiet/hot
    expect(by.get('E')!.quadrant).toBe('QUIET') //     quiet/quiet
    // D has no H_m → no divergence, no quadrant
    expect(by.get('D')!.hM).toBeNull()
    expect(by.get('D')!.divergence).toBeNull()
    expect(by.get('D')!.quadrant).toBeNull()

    // divergence = H_e − H_m
    expect(by.get('A')!.divergence).toBeCloseTo(0.0, 12)
    expect(by.get('B')!.divergence).toBeCloseTo(0.6, 12)
    expect(by.get('C')!.divergence).toBeCloseTo(-0.6, 12)

    // rank = canonical board index; rank_delta = priorRank − curRank (null when no prior rank)
    expect(out.map((s) => [s.ticker, s.rank])).toEqual([['A', 1], ['B', 2], ['D', 3], ['C', 4], ['E', 5]])
    expect(by.get('A')!.rankDelta).toBe(1) // 2 → 1
    expect(by.get('B')!.rankDelta).toBe(-1) // 1 → 2
    expect(by.get('C')!.rankDelta).toBe(-1) // 3 → 4
    expect(by.get('D')!.rankDelta).toBeNull() // no prior rank
    expect(by.get('E')!.rankDelta).toBeNull()

    // lead-lag is disabled by default → null for all (proven non-null with enabled:true in the next test)
    expect(out.every((s) => s.leadLagHrs === null)).toBe(true)

    // persists atomically through publishCycle
    await publishCycle(pg.db, {
      meta: meta(5),
      features: rows, signals: out,
    })
    const stored = await pg.db.select().from(signalsTable).where(eq(signalsTable.windowStart, W))
    expect(stored).toHaveLength(5)
    expect(stored.find((s) => s.ticker === 'C')!.quadrant).toBe('STEALTH')
  })

  it('uses the PRESERVED overlay (reads analytical_features at W) when no fresh overlay is given', async () => {
    // A committed overlay already exists at W (e.g. an earlier same-window cycle); freshAnalytical=undefined.
    await pg.db.insert(analyticalFeatures).values([ana('A', 0.9), ana('B', 0.1)])
    const rows = [ef('A', 0.9), ef('B', 0.2)]
    const out = await buildSignals(pg.db, W, WS, cfg, rows, undefined)
    const by = new Map(out.map((s) => [s.ticker, s]))
    expect(by.get('A')!.hM).toBeCloseTo(0.9, 12) // came from the preserved DB overlay
    expect(by.get('A')!.divergence).toBeCloseTo(0.0, 12)
    expect(by.get('B')!.hM).toBeCloseTo(0.1, 12)
    // quadrant is classified from the preserved H_m too (thrHe=med[.9,.2]=.55, thrHm=med[.9,.1]=.5)
    expect(by.get('A')!.quadrant).toBe('CONFIRMED') // .9>.55, .9>.5
    expect(by.get('B')!.quadrant).toBe('QUIET') //     .2<.55, .1<.5

    // and it persists atomically
    await publishCycle(pg.db, {
      meta: meta(2),
      features: rows, signals: out,
    })
    const stored = await pg.db.select().from(signalsTable).where(eq(signalsTable.windowStart, W))
    expect(stored.find((s) => s.ticker === 'A')!.quadrant).toBe('CONFIRMED')
  })

  it('withholds row-level quadrants below the distinct-author floor without hiding divergence', async () => {
    const supportedCfg = { ...cfg, minRowAuthors: 3 }
    const rows = [
      ef('THIN', 0.9, { authors: 1 }),
      ef('SUPPORTED', 0.2, { authors: 3 }),
    ]
    const fresh = [ana('THIN', 0.9), ana('SUPPORTED', 0.2)]
    const by = new Map((await buildSignals(pg.db, W, WS, supportedCfg, rows, fresh))
      .map((s) => [s.ticker, s]))

    expect(by.get('THIN')!.divergence).toBe(0)
    expect(by.get('THIN')!.quadrant).toBeNull()
    expect(by.get('SUPPORTED')!.quadrant).toBe('QUIET')
  })
})

describe('explicit heat finalization repair', () => {
  it('repairs stable signals before finalizing and leaves W−1 provisional', async () => {
    const stable = W - 2 * WS
    const provisional = W - WS
    await pg.db.insert(cycleRuns).values([
      { windowStart: stable, generatedAt: stable + 1, status: 'complete' },
      { windowStart: provisional, generatedAt: provisional + 1, status: 'complete' },
    ])
    await pg.db.insert(empiricalFeatures).values([
      { ticker: 'NVDA', windowStart: stable, mentions: 4, authors: 4, sov: 1, netDir: 0, ddCount: 0, baselineStatus: 'cold', hE: 0.8 },
      { ticker: 'NVDA', windowStart: provisional, mentions: 5, authors: 5, sov: 1, netDir: 0, ddCount: 0, baselineStatus: 'cold', hE: 0.9 },
    ])
    await pg.db.insert(signalsTable).values({
      ticker: 'NVDA', windowStart: stable, hE: 0.1, rank: 99,
    })

    expect(await repairFinalizedSignalDrift(pg.db, W, WS, cfg, {
      at: W + 10, scoringVersion: 'test-score', repairVersion: 'test-repair',
    })).toBe(1)

    const [stableCycle] = await pg.db.select().from(cycleRuns)
      .where(eq(cycleRuns.windowStart, stable))
    const [provisionalCycle] = await pg.db.select().from(cycleRuns)
      .where(eq(cycleRuns.windowStart, provisional))
    const [repaired] = await pg.db.select().from(signalsTable)
      .where(eq(signalsTable.windowStart, stable))
    expect(stableCycle).toMatchObject({
      finalizedAt: W + 10,
      repairedAt: W + 10,
      scoringVersion: 'test-score',
      repairVersion: 'test-repair',
    })
    expect(provisionalCycle!.finalizedAt).toBeNull()
    expect(repaired).toMatchObject({ hE: 0.8, rank: 1 })
  })

  it('leaves malformed legacy rows unfinalized without aborting catch-up', async () => {
    const stable = W - 3 * WS
    await pg.db.insert(cycleRuns).values({
      windowStart: stable, generatedAt: stable + 1, status: 'complete',
    })
    await pg.db.insert(empiricalFeatures).values({
      ticker: 'BROKEN', windowStart: stable, mentions: 1, authors: 1, sov: 1,
      netDir: 0, ddCount: 0, baselineStatus: 'cold', hE: null,
    })

    await expect(repairFinalizedSignalDrift(pg.db, W, WS, cfg, {
      at: W + 10, scoringVersion: 'test-score', repairVersion: 'test-repair',
    })).resolves.toBe(0)
    const [cycle] = await pg.db.select().from(cycleRuns)
      .where(eq(cycleRuns.windowStart, stable))
    expect(cycle!.finalizedAt).toBeNull()
  })
})

describe('buildSignals — lead-lag end-to-end', () => {
  it('reads the per-ticker H_e/H_m series and resolves a +2-window lead to +2h', async () => {
    const PI = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9, 3]
    // Seed 16 historical windows for LAG: H_e(k)=PI[k]; H_m(k)=PI[k−2] (H_e leads H_m by 2 windows).
    const empRows: EmpiricalFeatureInsert[] = []
    const anaRows: AnalyticalFeatureInsert[] = []
    PI.forEach((v, k) => {
      const ws = W - (16 - k) * WS // all strictly < W
      empRows.push(emp('LAG', ws, v))
      if (k - 2 >= 0) anaRows.push(ana('LAG', PI[k - 2]!, ws))
    })
    await pg.db.insert(empiricalFeatures).values(empRows)
    await pg.db.insert(analyticalFeatures).values(anaRows)

    // current window: keep the lag-2 alignment exact — H_m(now) must equal H_e two windows back (PI[14]).
    const rows = [ef('LAG', 3)]
    const fresh = [ana('LAG', PI[14]!)]
    const enabled: SignalsConfig = { ...cfg, leadLag: { ...cfg.leadLag, enabled: true } }
    const out = await buildSignals(pg.db, W, WS, enabled, rows, fresh)

    expect(out).toHaveLength(1)
    expect(out[0]!.leadLagHrs).toBeCloseTo(2, 12) // WSB attention leads market action by ~2h

    // and with lead-lag DISABLED (the default), the very same world yields null
    const off = await buildSignals(pg.db, W, WS, cfg, rows, fresh)
    expect(off[0]!.leadLagHrs).toBeNull()
  })
})
