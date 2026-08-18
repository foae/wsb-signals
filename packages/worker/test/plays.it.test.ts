import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { plays, type PlayMediaItem, type PlayRow } from '@wsb/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { PlaysConfig, WorkerConfig } from '../src/config'
import { loadConfig } from '../src/config'
import { createDb, latestCompleteWindow } from '../src/db'
import { TickerExtractor } from '../src/extract'
import type { PollResult, RawThing, Source } from '../src/ingest'
import { runCycle, type CycleDeps } from '../src/loop'
import { capturePlays } from '../src/plays/capture'
import { runQueueTick, type QueueDeps } from '../src/plays/queue'
import { startPg, type PgHarness } from './helpers/pg'

// P1 integration (plays-plan §3): capture idempotency under the poll's ~12× re-delivery (invariant P8),
// the queue's claim/lease/backoff semantics on real Postgres, media-state transitions (invariant P7),
// and radar-cycle isolation (invariant P1) — a plays failure never touches the radar's publish.

const NOW = 1_704_070_900 // windowStartFor(NOW, 3600) == WS
const WS = 1_704_070_800
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const TMP = join(tmpdir(), `wsb-plays-it-${process.pid}`)

const playsCfg = (over: Partial<PlaysConfig> = {}): PlaysConfig => ({
  enabled: true, flairs: new Set(['Gain', 'Loss', 'YOLO', 'Verified Trade']), queueIntervalSeconds: 60,
  maxAttempts: 4, leaseSeconds: 600, mediaRetrySeconds: 600, maxImagesStored: 20,
  maxImageBytes: 10 * 1024 * 1024, redditUserAgent: 'test-ua', mediaDir: TMP, ...over,
})

const rawPlay = (id: string, over: RawThing = {}): RawThing => ({
  id, created_utc: WS + 10, author: 'degen', title: `${id} gain`, selftext: '',
  link_flair_text: 'Gain', permalink: `/r/wsb/comments/${id}/x/`, url: 'https://i.redd.it/img1.jpeg',
  is_gallery: false, media_metadata: null, score: 1, num_comments: 0, ...over,
})

const item = (path: string): PlayMediaItem =>
  ({ order: 0, path, ext: 'jpg', bytes: 3, sha256: 'abc', sourceUrl: 'https://i.redd.it/img1.jpeg' })

let pg: PgHarness
let config: WorkerConfig
beforeAll(async () => {
  pg = await startPg()
  config = loadConfig(ROOT).worker
})
afterAll(async () => { await pg?.stop() })
beforeEach(async () => { await pg.reset() })

const getPlay = async (id: string): Promise<PlayRow> => {
  const rows = await pg.db.select().from(plays).where(eq(plays.id, id))
  expect(rows).toHaveLength(1)
  return rows[0]!
}

describe('capture idempotency (invariant P8)', () => {
  it('re-delivered posts insert once (ON CONFLICT DO NOTHING), stats reflect it', async () => {
    const raws = [rawPlay('p1'), rawPlay('dd1', { link_flair_text: 'DD' })]
    const first = await capturePlays(pg.db, raws, playsCfg(), NOW)
    expect(first).toMatchObject({ seen: 2, matched: 1, inserted: 1 })
    const second = await capturePlays(pg.db, raws, playsCfg(), NOW + 300)
    expect(second).toMatchObject({ seen: 2, matched: 1, inserted: 0 })
    expect(await pg.db.select().from(plays)).toHaveLength(1)
    expect((await getPlay('p1')).capturedAt).toBe(NOW) // first-seen kept, not refreshed
  })

  it('never moves status backwards: a re-delivery cannot reset an advanced row', async () => {
    await capturePlays(pg.db, [rawPlay('p1')], playsCfg(), NOW)
    await pg.db.update(plays)
      .set({ status: 'media_ready', mediaStatus: 'archived', media: [item('p1/0.jpg')] })
      .where(eq(plays.id, 'p1'))
    await capturePlays(pg.db, [rawPlay('p1')], playsCfg(), NOW + 300)
    const row = await getPlay('p1')
    expect(row.status).toBe('media_ready')
    expect(row.mediaStatus).toBe('archived') // nothing re-enqueued, nothing re-charged
  })
})

describe('queue claim / lease / stages', () => {
  const tick = (over: Partial<QueueDeps> & { clockNow?: number } = {}): ReturnType<typeof runQueueTick> => {
    const { clockNow, ...rest } = over
    return runQueueTick({
      db: pg.db, config: playsCfg(), clock: () => clockNow ?? NOW,
      media: async () => ({ items: [item('p1/0.jpg')], retryable: false, none: false, aborted: false }),
      ...rest,
    })
  }

  it('captured → media_ready (archived): claim, stage, advance, release', async () => {
    await capturePlays(pg.db, [rawPlay('p1')], playsCfg(), NOW)
    const stats = await tick()
    expect(stats).toMatchObject({ claimed: 1, advanced: 1, retrying: 0, failed: 0 })
    const row = await getPlay('p1')
    expect(row.status).toBe('media_ready')
    expect(row.mediaStatus).toBe('archived')
    expect(row.media).toEqual([item('p1/0.jpg')])
    expect(row.claimedAt).toBeNull()
    expect(row.attempts).toBe(0)
    expect(row.error).toBeNull()
  })

  it('text-only plays advance with media_status none', async () => {
    await capturePlays(pg.db, [rawPlay('p1', { url: '', media_metadata: null })], playsCfg(), NOW)
    await tick({ media: async () => ({ items: [], retryable: false, none: true, aborted: false }) })
    const row = await getPlay('p1')
    expect(row.status).toBe('media_ready')
    expect(row.mediaStatus).toBe('none')
    expect(row.media).toBeNull()
  })

  it('transient media failure: retries inside the window, then degrades to text-only (invariant P7)', async () => {
    await capturePlays(pg.db, [rawPlay('p1')], playsCfg(), NOW)
    const transient = async (): Promise<{ items: []; retryable: true; none: false; aborted: false }> =>
      ({ items: [], retryable: true, none: false, aborted: false })

    // First pass: schedules a retry — status STAYS captured, the window opens.
    expect(await tick({ media: transient })).toMatchObject({ claimed: 1, retrying: 1, advanced: 0 })
    let row = await getPlay('p1')
    expect(row.status).toBe('captured')
    expect(row.mediaStatus).toBe('pending')
    expect(row.mediaRetryUntil).toBe(NOW + 600)
    expect(row.nextAttemptAt).toBe(NOW + 60)
    expect(row.claimedAt).toBeNull()

    // Before next_attempt_at: not due, not claimed.
    expect(await tick({ media: transient, clockNow: NOW + 30 })).toMatchObject({ claimed: 0 })

    // Still failing past the window: keep nothing → degrade to text-only, queue proceeds.
    expect(await tick({ media: transient, clockNow: NOW + 700 })).toMatchObject({ claimed: 1, advanced: 1 })
    row = await getPlay('p1')
    expect(row.status).toBe('media_ready')
    expect(row.mediaStatus).toBe('failed')
  })

  it('a stage crash backs off via attempts and is terminal only at max_attempts', async () => {
    await capturePlays(pg.db, [rawPlay('p1')], playsCfg(), NOW)
    const boom = async (): Promise<never> => { throw new Error('stage boom') }
    const cfg = playsCfg({ maxAttempts: 2 })

    expect(await tick({ media: boom, config: cfg })).toMatchObject({ claimed: 1, failed: 0 })
    let row = await getPlay('p1')
    expect(row.status).toBe('captured')
    expect(row.attempts).toBe(1)
    expect(row.error).toContain('stage boom')
    expect(row.nextAttemptAt).toBe(NOW + 60) // 60s · 2^0
    expect(row.claimedAt).toBeNull()

    expect(await tick({ media: boom, config: cfg, clockNow: NOW + 120 })).toMatchObject({ claimed: 1, failed: 1 })
    row = await getPlay('p1')
    expect(row.status).toBe('failed') // terminal — but only after max_attempts
    expect(row.attempts).toBe(2)
  })

  it('the lease: a live claim blocks re-claiming; a stale claim is recovered', async () => {
    await capturePlays(pg.db, [rawPlay('p1')], playsCfg(), NOW)
    // Simulate a crashed claimer: claimed recently (inside lease_minutes) → skipped.
    await pg.db.update(plays).set({ claimedAt: NOW - 100 }).where(eq(plays.id, 'p1'))
    expect(await tick()).toMatchObject({ claimed: 0 })
    // Lease expired → re-claimable, processed.
    await pg.db.update(plays).set({ claimedAt: NOW - 700 }).where(eq(plays.id, 'p1'))
    expect(await tick()).toMatchObject({ claimed: 1, advanced: 1 })
  })

  it('a shutdown-aborted stage releases the claim UNCHANGED — no degrade, no retry window (P7)', async () => {
    await capturePlays(pg.db, [rawPlay('p1')], playsCfg(), NOW)
    const stats = await tick({
      media: async () => ({ items: [], retryable: false, none: false, aborted: true }),
    })
    expect(stats).toMatchObject({ claimed: 1, retrying: 1, advanced: 0, failed: 0 })
    const row = await getPlay('p1')
    expect(row.status).toBe('captured') // still due — a deploy must not cost the play its media
    expect(row.mediaStatus).toBe('pending')
    expect(row.mediaRetryUntil).toBeNull() // restarts must not burn the transient-failure window
    expect(row.claimedAt).toBeNull()
    expect(row.attempts).toBe(0)
    expect(row.nextAttemptAt).toBe(NOW) // due immediately after restart
  })

  it('fences every update on the claim: a lease-expired straggler cannot clobber a re-claimer', async () => {
    await capturePlays(pg.db, [rawPlay('p1')], playsCfg(), NOW)
    // The stage simulates a straggler losing its lease mid-flight: a re-claimer stamps a NEW claimed_at
    // while this stage is running; the straggler's advance must then be a silent no-op.
    const stats = await tick({
      media: async () => {
        await pg.db.update(plays).set({ claimedAt: NOW + 999 }).where(eq(plays.id, 'p1'))
        return { items: [item('p1/0.jpg')], retryable: false, none: false, aborted: false }
      },
    })
    expect(stats).toMatchObject({ claimed: 1 })
    const row = await getPlay('p1')
    expect(row.status).toBe('captured') // the straggler's advance was fenced out
    expect(row.claimedAt).toBe(NOW + 999) // the re-claimer's claim is untouched
    expect(row.media).toBeNull()
  })

  it('persists partial items on retry and keeps them through a later degrade (manifest never shrinks)', async () => {
    await capturePlays(pg.db, [rawPlay('p1')], playsCfg(), NOW)
    // Attempt 1: one image archived, another transiently failing → retry scheduled, partial persisted.
    await tick({
      media: async () => ({ items: [item('p1/0.jpg')], retryable: true, none: false, aborted: false }),
    })
    let row = await getPlay('p1')
    expect(row.status).toBe('captured')
    expect(row.media).toEqual([item('p1/0.jpg')]) // persisted for reuse by the next attempt
    // Attempt 2, window exhausted, and THIS attempt resolves nothing (e.g. post JSON now 404s):
    // the prior archived item must still make the play `archived`, not text-only.
    await tick({
      clockNow: NOW + 700,
      media: async () => ({ items: [], retryable: true, none: false, aborted: false }),
    })
    row = await getPlay('p1')
    expect(row.status).toBe('media_ready')
    expect(row.mediaStatus).toBe('archived')
    expect(row.media).toEqual([item('p1/0.jpg')])
  })

  it('media_ready rows rest untouched (LLM stages land at P2)', async () => {
    await capturePlays(pg.db, [rawPlay('p1')], playsCfg(), NOW)
    await tick()
    expect(await tick({ clockNow: NOW + 3600 })).toMatchObject({ claimed: 0 })
    expect((await getPlay('p1')).status).toBe('media_ready')
  })
})

describe('radar-cycle integration (invariant P1)', () => {
  class FakeSource implements Source {
    readonly name = 'fake'
    constructor(private readonly make: () => PollResult) {}
    async poll(): Promise<PollResult> { return this.make() }
    async close(): Promise<void> {}
  }

  const okPoll = (over: Partial<PollResult> = {}): PollResult => ({
    posts: [{ id: 'p1', createdUtc: WS + 10, author: 'degen', title: 'NVDA gain', selftext: '',
      linkFlairText: 'Gain', score: null, numComments: null, retrievedOn: NOW, source: 'fake' }],
    comments: [], rawPosts: [rawPlay('p1', { title: 'NVDA gain' })],
    newestUtc: WS + 10, capped: false, ok: true, postsOk: true, ...over,
  })

  const deps = (over: Partial<CycleDeps> = {}): CycleDeps => ({
    db: pg.db, source: new FakeSource(okPoll), market: null,
    extractor: new TickerExtractor(new Set<string>(), { whitelist: new Set(['NVDA']) }),
    bots: new Set(), config, markPoll: () => {},
    plays: { db: pg.db, config: playsCfg() }, ...over,
  })

  it('a normal cycle captures plays AFTER publishing the radar window', async () => {
    const res = await runCycle(deps(), NOW)
    expect(res.skipped).toBe(false)
    expect(await latestCompleteWindow(pg.db)).toBe(WS) // radar published
    const row = await getPlay('p1')
    expect(row.status).toBe('captured')
    expect(row.mediaStatus).toBe('pending')
    expect(row.raw).toEqual(rawPlay('p1', { title: 'NVDA gain' }))
  })

  it('a comments-side-failed poll still captures plays (keys on postsOk), radar discards whole', async () => {
    const res = await runCycle(deps({ source: new FakeSource(() => okPoll({ ok: false, postsOk: true })) }), NOW)
    expect(res.skipped).toBe(true)
    expect(await latestCompleteWindow(pg.db)).toBeNull() // radar window discarded whole
    expect((await getPlay('p1')).status).toBe('captured') // …but the play was not lost
  })

  it('a fully-failed poll captures nothing', async () => {
    await runCycle(deps({ source: new FakeSource(() => okPoll({ ok: false, postsOk: false })) }), NOW)
    expect(await pg.db.select().from(plays)).toHaveLength(0)
  })

  it('a broken plays DB never touches the radar publish (capture is best-effort)', async () => {
    const dead = createDb(pg.container.getConnectionUri())
    await dead.close() // every plays query on this handle will throw
    const res = await runCycle(deps({ plays: { db: dead.db, config: playsCfg() } }), NOW)
    expect(res.skipped).toBe(false)
    expect(res.readbackOk).toBe(true)
    expect(await latestCompleteWindow(pg.db)).toBe(WS) // the radar cycle published regardless
    expect(await pg.db.select().from(plays)).toHaveLength(0)
  })
})
