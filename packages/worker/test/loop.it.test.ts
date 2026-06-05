import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  analyticalFeatures, empiricalFeatures, mentions as mentionsTable, rawComments, rawPosts,
  type MarketMoverInsert, type RawCommentInsert, type RawPostInsert,
} from '@wsb/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { WorkerConfig } from '../src/config'
import { loadConfig } from '../src/config'
import { latestCompleteWindow } from '../src/db'
import { TickerExtractor } from '../src/extract'
import type { PollResult, Source } from '../src/ingest'
import { runCycle, runLoop, type CycleDeps } from '../src/loop'
import type { MarketData, StockSnapshot } from '../src/market'
import { startPg, type PgHarness } from './helpers/pg'

// Slice-6 integration (porting-spec §7): the full cycle + loop lifecycle, on real Postgres with a fake
// source/market. Covers the cycle order + atomic publish, the !ok DISCARD, market never-kill, and the
// loop's once / self-heal / graceful-stop / cleanup behaviors.

const NOW = 1_704_070_900 // windowStartFor(NOW, 3600) == WS
const WS = 1_704_070_800
const TMP = join(tmpdir(), 'wsb-loop-it') // markPoll is injected (no fs); lastPollAt on a missing dir → null

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const extractor = new TickerExtractor(new Set<string>(), { whitelist: new Set(['NVDA', 'AMD']) })
let config: WorkerConfig

const post = (id: string, author: string, title: string, created: number): RawPostInsert =>
  ({ id, createdUtc: created, author, title, selftext: '', linkFlairText: null, score: null, numComments: null, retrievedOn: NOW, source: 'fake' })
const comment = (id: string, author: string, body: string, created: number): RawCommentInsert =>
  ({ id, createdUtc: created, author, linkId: null, parentId: null, body, score: null, retrievedOn: NOW, source: 'fake' })
const snap = (ticker: string, price: number, prevClose: number): StockSnapshot =>
  ({ ticker, price, dayOpen: null, dayClose: null, dayVolume: null, prevClose, prevVolume: null, feed: 'iex', asOf: NOW })

const okPoll = (): PollResult => ({
  posts: [post('p1', 'alice', 'NVDA calls', WS + 10)],
  comments: [comment('c1', 'bob', 'AMD puts', WS + 20)],
  newestUtc: WS + 20, capped: false, ok: true,
})
const emptyPoll = (): PollResult => ({ posts: [], comments: [], newestUtc: null, capped: false, ok: true })

class FakeSource implements Source {
  readonly name = 'fake'
  pollCount = 0
  closed = false
  constructor(private readonly make: () => PollResult | Promise<PollResult>) {}
  async poll(): Promise<PollResult> {
    this.pollCount++
    return this.make()
  }
  async close(): Promise<void> { this.closed = true }
}

class FakeMarket implements MarketData {
  readonly name = 'fake'
  closed = false
  constructor(
    private readonly snaps: Map<string, StockSnapshot>,
    private readonly movers: MarketMoverInsert[] = [],
    private readonly failSnapshots = false,
  ) {}
  async snapshots(): Promise<Map<string, StockSnapshot>> {
    if (this.failSnapshots) throw new Error('alpaca down')
    return this.snaps
  }
  async screeners(): Promise<MarketMoverInsert[]> { return this.movers }
  async close(): Promise<void> { this.closed = true }
}

let pg: PgHarness
beforeAll(async () => {
  pg = await startPg()
  config = loadConfig(ROOT).worker
})
afterAll(async () => { await pg?.stop() })
beforeEach(async () => { await pg.reset() })

const deps = (over: Partial<CycleDeps>): CycleDeps => ({
  db: pg.db, source: new FakeSource(okPoll), market: null, extractor, bots: new Set(), config,
  markPoll: () => {}, ...over,
})

describe('runCycle', () => {
  it('persists raw + mentions, publishes the window + marker, and prices the overlay', async () => {
    const market = new FakeMarket(new Map([['NVDA', snap('NVDA', 110, 100)]]))
    const marked: number[] = []
    const res = await runCycle(deps({ market, markPoll: (t) => { marked.push(t) } }), NOW)

    expect(res.skipped).toBe(false)
    expect(marked).toEqual([NOW])
    expect(await pg.db.select().from(rawPosts)).toHaveLength(1)
    expect(await pg.db.select().from(rawComments)).toHaveLength(1)
    expect((await pg.db.select().from(mentionsTable)).map((m) => m.ticker).sort()).toEqual(['AMD', 'NVDA'])

    const feats = await pg.db.select().from(empiricalFeatures).where(eq(empiricalFeatures.windowStart, WS))
    expect(feats.map((f) => f.ticker).sort()).toEqual(['AMD', 'NVDA'])
    expect(await latestCompleteWindow(pg.db)).toBe(WS)
    const ana = await pg.db.select().from(analyticalFeatures).where(eq(analyticalFeatures.windowStart, WS))
    expect(ana.map((a) => a.ticker)).toEqual(['NVDA']) // only NVDA had a snapshot
  })

  it('discards a !ok poll WHOLE — nothing persisted, no marker', async () => {
    const marked: number[] = []
    const res = await runCycle(deps({
      source: new FakeSource(() => ({ ...okPoll(), ok: false })),
      markPoll: (t) => { marked.push(t) },
    }), NOW)

    expect(res.skipped).toBe(true)
    expect(marked).toEqual([]) // not marked → a restart can retry promptly
    expect(await pg.db.select().from(rawPosts)).toHaveLength(0)
    expect(await pg.db.select().from(mentionsTable)).toHaveLength(0)
    expect(await latestCompleteWindow(pg.db)).toBeNull()
  })

  it('survives a market failure — publishes empirical-only (never-kill)', async () => {
    const market = new FakeMarket(new Map(), [], true) // snapshots throws
    const res = await runCycle(deps({ market }), NOW)

    expect(res.skipped).toBe(false)
    const feats = await pg.db.select().from(empiricalFeatures).where(eq(empiricalFeatures.windowStart, WS))
    expect(feats).toHaveLength(2) // features still published
    expect(await latestCompleteWindow(pg.db)).toBe(WS) // marker present
    expect(await pg.db.select().from(analyticalFeatures).where(eq(analyticalFeatures.windowStart, WS))).toHaveLength(0)
  })
})

const loopOpts = (over: Record<string, unknown> = {}): Parameters<typeof runLoop>[1] => ({
  once: true, intervalSeconds: 300, minPollGapSeconds: 0, dataDir: TMP,
  clock: () => NOW, sleep: async () => {}, installHandlers: false, ...over,
})

describe('runLoop lifecycle', () => {
  it('once: runs exactly one cycle', async () => {
    const source = new FakeSource(emptyPoll)
    await runLoop(deps({ source }), loopOpts())
    expect(source.pollCount).toBe(1)
  })

  it('self-heals: a throwing cycle is caught, the loop does not crash', async () => {
    const source = new FakeSource(() => { throw new Error('source blip') })
    await expect(runLoop(deps({ source }), loopOpts())).resolves.toBeUndefined()
    expect(source.pollCount).toBe(1)
  })

  it('stops gracefully when the stop signal aborts (no extra cycle)', async () => {
    const controller = new AbortController()
    let cycles = 0
    const source = new FakeSource(() => {
      cycles++
      if (cycles >= 2) controller.abort()
      return emptyPoll()
    })
    await runLoop(deps({ source }), loopOpts({ once: false, stopSignal: controller.signal }))
    expect(cycles).toBe(2)
  })

  it('closes the source and market on exit', async () => {
    const source = new FakeSource(emptyPoll)
    const market = new FakeMarket(new Map())
    await runLoop(deps({ source, market }), loopOpts())
    expect(source.closed).toBe(true)
    expect(market.closed).toBe(true)
  })
})
