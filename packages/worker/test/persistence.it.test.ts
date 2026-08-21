import { and, count, eq } from 'drizzle-orm'
import {
  analyticalFeatures, cycleRuns, empiricalFeatures, mentions as mentionsTable, rawPosts,
  signals as signalsTable, type AnalyticalFeatureInsert,
} from '@wsb/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { EmpiricalFeature } from '../src/aggregate'
import type { SignalsConfig } from '../src/analytics'
import {
  latestCompleteWindow, publishCycle, readMentionsInWindow, upsertEmpiricalFeatures, upsertMentions,
  upsertPosts,
} from '../src/db'
import { repairRemovedHeatHistory, type AggregateConfig } from '../src/pipeline'
import { startPg, type PgHarness } from './helpers/pg'

// Slice-3 persistence: exercises the EXACT per-table ON CONFLICT semantics, ≤1000-row chunking, and the
// atomic per-cycle publish — on a real Postgres (testcontainers). Run with `pnpm test:it` (needs Docker).

function feature(ticker: string, windowStart: number, over: Partial<EmpiricalFeature> = {}): EmpiricalFeature {
  return {
    ticker, windowStart, mentions: 3, authors: 2, sov: 0.5, velocity: 1, accel: null, z: null,
    netDir: 0, ddCount: 0, flairCounts: {}, baselineStatus: 'cold', hE: 0.4, ...over,
  }
}
const cycleMeta = (windowStart: number, totalMentions: number, newestUtc: number | null = null) => ({
  windowStart, scoringVersion: 'test-heat', generatedAt: windowStart + 100,
  totalMentions, quiet: false, capped: false, newestUtc,
  newestPostUtc: newestUtc, newestCommentUtc: newestUtc,
  marketStatus: 'unavailable' as const, marketRequested: 0, marketUsable: 0, marketAsOf: null,
})

let pg: PgHarness

beforeAll(async () => { pg = await startPg() })
afterAll(async () => { await pg?.stop() })
beforeEach(async () => { await pg.reset() })

describe('persistence on Postgres', () => {
  it('round-trips empirical features (incl. flairCounts JSONB + null velocity/accel)', async () => {
    const f = feature('NVDA', 3600, { flairCounts: { DD: 1, YOLO: 2 }, velocity: null, accel: null, hE: 0.95 })
    await upsertEmpiricalFeatures(pg.db, [f])
    const rows = await pg.db.select().from(empiricalFeatures).where(eq(empiricalFeatures.ticker, 'NVDA'))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.flairCounts).toEqual({ DD: 1, YOLO: 2 }) // JSONB → object, not a string
    expect(rows[0]!.velocity).toBeNull()
    expect(rows[0]!.hE).toBeCloseTo(0.95, 9)
  })

  it('mentions are immutable — ON CONFLICT DO NOTHING keeps first-seen', async () => {
    await upsertMentions(pg.db, [{ ticker: 'GME', thingId: 't1', thingType: 'post', author: 'first' }])
    await upsertMentions(pg.db, [{ ticker: 'GME', thingId: 't1', thingType: 'post', author: 'second' }])
    const rows = await pg.db.select().from(mentionsTable).where(eq(mentionsTable.thingId, 't1'))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.author).toBe('first') // unchanged
  })

  it('posts keep first-seen title but refresh engagement (DO UPDATE subset)', async () => {
    await upsertPosts(pg.db, [{ id: 'p1', title: 'Original', score: 5, numComments: 1, author: 'op' }])
    await upsertPosts(pg.db, [{ id: 'p1', title: 'EDITED', score: 99, numComments: 42, author: 'someone' }])
    const rows = await pg.db.select().from(rawPosts).where(eq(rawPosts.id, 'p1'))
    expect(rows[0]!.title).toBe('Original') // first-seen kept
    expect(rows[0]!.author).toBe('op') // first-seen kept
    expect(rows[0]!.score).toBe(99) // engagement refreshed
    expect(rows[0]!.numComments).toBe(42)
  })

  it('excludes a mention after its source post is observed removed', async () => {
    await upsertPosts(pg.db, [{
      id: 'gone', createdUtc: 100, title: 'NVDA calls', selftext: '', removed: false,
    }])
    await upsertMentions(pg.db, [{
      ticker: 'NVDA', thingId: 'gone', thingType: 'post', createdUtc: 100, author: 'u',
    }])
    expect(await readMentionsInWindow(pg.db, 0, 200)).toHaveLength(1)

    await upsertPosts(pg.db, [{
      id: 'gone', createdUtc: 100, title: '[removed]', selftext: '[removed]', removed: true,
    }])
    expect(await readMentionsInWindow(pg.db, 0, 200)).toHaveLength(0)
    const [stored] = await pg.db.select().from(rawPosts).where(eq(rawPosts.id, 'gone'))
    expect(stored).toMatchObject({ title: 'NVDA calls', removed: true })
  })

  it('empirical features DO UPDATE on re-aggregation of the same window', async () => {
    await upsertEmpiricalFeatures(pg.db, [feature('AMD', 3600, { hE: 0.4, mentions: 3 })])
    await upsertEmpiricalFeatures(pg.db, [feature('AMD', 3600, { hE: 0.9, mentions: 7 })])
    const rows = await pg.db.select().from(empiricalFeatures)
      .where(and(eq(empiricalFeatures.ticker, 'AMD'), eq(empiricalFeatures.windowStart, 3600)))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.hE).toBeCloseTo(0.9, 9)
    expect(rows[0]!.mentions).toBe(7)
  })

  it('chunks a batch that exceeds the 65535 bind-param cap', async () => {
    // 10000 rows × 7 cols = 70000 params — would overflow a single INSERT; chunking splits it.
    const rows = Array.from({ length: 10_000 }, (_, i) => ({
      ticker: 'SPY', thingId: `c${i}`, thingType: 'comment', author: `u${i % 50}`,
    }))
    await upsertMentions(pg.db, rows)
    const [row] = await pg.db.select({ c: count() }).from(mentionsTable)
    expect(row!.c).toBe(10_000)
  })

  it('publishCycle is atomic and records the latest complete window', async () => {
    expect(await latestCompleteWindow(pg.db)).toBeNull()
    await publishCycle(pg.db, {
      meta: cycleMeta(7200, 12, 7250),
      features: [feature('NVDA', 7200, { hE: 0.95 }), feature('AMD', 7200, { hE: 0.3 })],
    })
    expect(await latestCompleteWindow(pg.db)).toBe(7200)
    const feats = await pg.db.select().from(empiricalFeatures).where(eq(empiricalFeatures.windowStart, 7200))
    expect(feats).toHaveLength(2)
  })

  it('publishCycle replaces the window analytical set, but preserves it when no overlay is given', async () => {
    const meta = cycleMeta(4000, 5)
    const an = (ticker: string, hM: number): AnalyticalFeatureInsert =>
      ({ ticker, windowStart: 4000, hM, rvolConf: 'low' })
    const analyticalAt = () => pg.db.select().from(analyticalFeatures)
      .where(eq(analyticalFeatures.windowStart, 4000))

    // publish A + B
    await publishCycle(pg.db, {
      meta, features: [feature('A', 4000), feature('B', 4000)], analytical: [an('A', 0.5), an('B', 0.3)],
    })
    expect((await analyticalAt()).map((r) => r.ticker).sort()).toEqual(['A', 'B'])

    // re-publish with A only → stale B is removed (exact-cycle replacement)
    await publishCycle(pg.db, { meta, features: [feature('A', 4000)], analytical: [an('A', 0.9)] })
    const after = await analyticalAt()
    expect((await pg.db.select().from(empiricalFeatures)
      .where(eq(empiricalFeatures.windowStart, 4000))).map((r) => r.ticker)).toEqual(['A'])
    expect(after.map((r) => r.ticker)).toEqual(['A'])
    expect(after[0]!.hM).toBeCloseTo(0.9, 9)

    // re-publish with NO overlay (undefined) → prior overlay preserved (best-effort never-kill)
    await publishCycle(pg.db, { meta, features: [feature('A', 4000)] })
    expect((await analyticalAt()).map((r) => r.ticker)).toEqual(['A'])
  })

  it('a failed publish transaction rolls back — no partial cycle is visible', async () => {
    await expect(pg.db.transaction(async (tx) => {
      await upsertEmpiricalFeatures(tx, [feature('FAIL', 9000, { hE: 0.5 })])
      throw new Error('boom') // simulate a mid-cycle failure
    })).rejects.toThrow('boom')
    const rows = await pg.db.select().from(empiricalFeatures).where(eq(empiricalFeatures.windowStart, 9000))
    expect(rows).toHaveLength(0) // rolled back
  })

  it('replays newly removed stable content forward and records the repair contract', async () => {
    const first = 3600
    const second = 7200
    const aggregateCfg: AggregateConfig = {
      windowSeconds: 3600,
      weights: { sov: 0.35, accel: 0.25, rank_delta: 0.15, authors: 0.15, conviction: 0.05, net_dir: 0.05, z: 0 },
      minSamplesReady: 8,
      baselineLookbackSeconds: 26 * 7 * 24 * 3600,
      minAuthorsFull: 3,
    }
    const signalsCfg: SignalsConfig = {
      medianLookbackSeconds: 24 * 3600,
      minQuadrantPopulation: 5,
      minRowAuthors: 3,
      leadLag: { enabled: false, lookbackSeconds: 24 * 3600, maxLagWindows: 6, minPairs: 10, minCorr: 0.5 },
    }
    await pg.db.insert(cycleRuns).values([
      { windowStart: first, generatedAt: 7000, finalizedAt: 8000, totalMentions: 2, quiet: false, status: 'complete' },
      { windowStart: second, generatedAt: 9000, finalizedAt: 10_000, totalMentions: 1, quiet: false, status: 'complete' },
    ])
    await upsertPosts(pg.db, [
      { id: 'removed-first', createdUtc: first + 1, removed: true, retrievedOn: 9000 },
      { id: 'live-first', createdUtc: first + 2, removed: false, retrievedOn: 7000 },
      { id: 'live-second', createdUtc: second + 1, removed: false, retrievedOn: 9000 },
    ])
    await upsertMentions(pg.db, [
      { ticker: 'NVDA', thingId: 'removed-first', thingType: 'post', createdUtc: first + 1, author: 'a' },
      { ticker: 'AMD', thingId: 'live-first', thingType: 'post', createdUtc: first + 2, author: 'b' },
      { ticker: 'NVDA', thingId: 'live-second', thingType: 'post', createdUtc: second + 1, author: 'c' },
    ])
    await upsertEmpiricalFeatures(pg.db, [
      feature('NVDA', first, { mentions: 1, authors: 1 }),
      feature('AMD', first, { mentions: 1, authors: 1 }),
      feature('NVDA', second, { mentions: 1, authors: 1, velocity: 0 }),
    ])
    await pg.db.insert(signalsTable).values([
      { ticker: 'NVDA', windowStart: first, hE: 0.4, rank: 1 },
      { ticker: 'AMD', windowStart: first, hE: 0.4, rank: 2 },
      { ticker: 'NVDA', windowStart: second, hE: 0.4, rank: 1 },
    ])

    const stamp = {
      at: 11_000,
      scoringVersion: 'score-v2',
      repairVersion: 'removed-v2',
      minWindowMentions: 2,
    }
    expect(await repairRemovedHeatHistory(
      pg.db, 14_400, 3600, aggregateCfg, signalsCfg, stamp,
    )).toBe(2)
    expect((await pg.db.select().from(empiricalFeatures)
      .where(eq(empiricalFeatures.windowStart, first))).map((row) => row.ticker)).toEqual(['AMD'])
    const [downstream] = await pg.db.select().from(empiricalFeatures)
      .where(and(eq(empiricalFeatures.windowStart, second), eq(empiricalFeatures.ticker, 'NVDA')))
    expect(downstream!.velocity).toBe(1)
    const [firstCycle] = await pg.db.select().from(cycleRuns)
      .where(eq(cycleRuns.windowStart, first))
    expect(firstCycle).toMatchObject({
      repairedAt: 11_000,
      repairVersion: 'removed-v2',
      scoringVersion: 'score-v2',
      totalMentions: 1,
      quiet: true,
    })
    expect(await repairRemovedHeatHistory(
      pg.db, 14_400, 3600, aggregateCfg, signalsCfg, { ...stamp, at: 12_000 },
    )).toBe(0)

    // A newly observed removal in an already-versioned window invalidates it and every downstream
    // derivative; the observation timestamp, not a manually bumped version, drives the replay.
    await upsertPosts(pg.db, [{
      id: 'live-first', createdUtc: first + 2, removed: true, retrievedOn: 12_500,
    }])
    expect(await repairRemovedHeatHistory(
      pg.db, 14_400, 3600, aggregateCfg, signalsCfg, { ...stamp, at: 13_000 },
    )).toBe(2)
    expect(await pg.db.select().from(empiricalFeatures)
      .where(eq(empiricalFeatures.windowStart, first))).toEqual([])
    const [replayed] = await pg.db.select().from(empiricalFeatures)
      .where(and(eq(empiricalFeatures.windowStart, second), eq(empiricalFeatures.ticker, 'NVDA')))
    expect(replayed!.velocity).toBeNull()
  })
})
