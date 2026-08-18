import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { playExtractions, plays, type PlayMediaItem, type PlayRow } from '@wsb/shared'
import { APICallError } from 'ai'
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
  maxAttempts: 4, leaseSeconds: 600, mediaRetrySeconds: 600, maxImagesStored: 20, maxImagesLlm: 8,
  maxImageBytes: 10 * 1024 * 1024, maxRequestBytes: 24 * 1024 * 1024, redditUserAgent: 'test-ua',
  mediaDir: TMP,
  llm: {
    provider: 'openai', extractModel: 'test-model', interpretModel: 'test-model', maxPlaysPerTick: 5,
    maxOutputTokens: 2000, dailyBudgetUsd: 5,
    prices: { 'test-model': { input: 1, output: 4 } }, // $/Mtok — usable by default; tests override to refuse
  },
  ...over,
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
    expect(stats).toMatchObject({ claimed: 1, advanced: 0, retrying: 0, failed: 0 }) // fenced ≠ work done
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

describe('extraction stage (P2): fail-closed metering + the LLM seam on real Postgres', () => {
  const llmOut = () => ({
    screenshot_kind: 'single_position' as const, broker: 'Robinhood',
    positions: [{
      ticker: 'NVDA', instrument: 'call' as const, side: 'long' as const, quantity: 2, avg_price: 3.5,
      strike: 150, expiry: '2026-09-18', cost_basis: 700, current_value: 1200, pnl_abs: 500,
      pnl_pct: 71.4, realized: false, opened_at: null, currency: null, confidence: 0.9,
      field_confidence: null,
    }],
    notes: null, confidence: 0.85,
  })

  /** Countable fake PlayAnalyzer — dispatch refusals must never reach it (money). */
  const fakeAnalyzer = () => {
    const calls: number[] = []
    return {
      calls,
      extract: async () => {
        calls.push(1)
        return {
          extraction: llmOut(),
          usage: { inputTokens: 10_000, outputTokens: 500 },
          model: 'test-model', promptVersion: 'extract-prompt-v1',
        }
      },
    }
  }

  /** Seed one play already at media_ready (text-only — no files on disk needed for the seam test). */
  const seedMediaReady = async (id = 'p1'): Promise<void> => {
    await capturePlays(pg.db, [rawPlay(id)], playsCfg(), NOW)
    await pg.db.update(plays)
      .set({ status: 'media_ready', mediaStatus: 'none', media: null, nextAttemptAt: NOW })
      .where(eq(plays.id, id))
  }

  const extractTick = (analyzer: QueueDeps['analyzer'], over: Partial<QueueDeps> = {}): ReturnType<typeof runQueueTick> =>
    runQueueTick({
      db: pg.db, config: playsCfg(), clock: () => NOW, analyzer,
      isListedTicker: (t) => t === 'NVDA', ...over,
    })

  it('media_ready → extracted: play_extractions row (validated output, real cost), pointers set', async () => {
    await seedMediaReady()
    const analyzer = fakeAnalyzer()
    const stats = await extractTick(analyzer)
    expect(stats).toMatchObject({ extracted: 1, parked: 0, failed: 0 })
    expect(analyzer.calls).toHaveLength(1)

    const row = await getPlay('p1')
    expect(row.status).toBe('extracted')
    expect(row.claimedAt).toBeNull()
    expect(row.attempts).toBe(0)

    const runs = await pg.db.select().from(playExtractions)
    expect(runs).toHaveLength(1)
    expect(row.currentExtractionAt).toBe(runs[0]!.runAt) // the pointer names the winning run (wall-clock ms)
    expect(runs[0]).toMatchObject({
      playId: 'p1', model: 'test-model',
      promptVersion: 'extract-prompt-v1/extract-schema-v1',
      tokensIn: 10_000, tokensOut: 500,
    })
    // 10k in @ $1/M + 500 out @ $4/M (playsCfg test prices) = $0.012
    expect(runs[0]!.costUsd).toBeCloseTo(0.012, 9)
    const out = runs[0]!.output as { direction: string; confidence: number; positions: { ticker_outcome: string }[] }
    expect(out.direction).toBe('bullish')
    expect(out.positions[0]!.ticker_outcome).toBe('validated')
  })

  it('FAIL-CLOSED: the shipped all-zero prices park the play — the analyzer is never called', async () => {
    await seedMediaReady()
    const analyzer = fakeAnalyzer()
    const cfg = playsCfg()
    cfg.llm.prices = { 'test-model': { input: 0, output: 0 } } // the committed-config shape
    const stats = await extractTick(analyzer, { config: cfg })
    expect(stats).toMatchObject({ extracted: 0, parked: 1, failed: 0 })
    expect(analyzer.calls).toHaveLength(0) // no dispatch, no spend
    const row = await getPlay('p1')
    expect(row.status).toBe('media_ready') // waiting, not failing
    expect(row.attempts).toBe(0) // a refusal is not a fault
    expect(row.nextAttemptAt).toBeGreaterThan(NOW) // parked, re-checked later
    expect(await pg.db.select().from(playExtractions)).toHaveLength(0)
  })

  it('RESTART-PROOF budget: spend already in the DB counts — the cap survives a process restart', async () => {
    await seedMediaReady()
    // A previous process (or run) already spent the whole daily budget today (UTC of NOW).
    await pg.db.insert(playExtractions).values({
      playId: 'p1', runAt: NOW * 1000 - 1000, model: 'test-model', promptVersion: 'x',
      output: {}, tokensIn: 1, tokensOut: 1, costUsd: 4.999,
    })
    const analyzer = fakeAnalyzer()
    const stats = await extractTick(analyzer)
    expect(stats).toMatchObject({ extracted: 0, parked: 1 })
    expect(analyzer.calls).toHaveLength(0)
    expect((await getPlay('p1')).status).toBe('media_ready')
  })

  it('an analyzer crash is a stage fault: attempts bump + backoff, then terminal at max_attempts — and every attempt’s RESERVATION stays on the meter (fail-closed)', async () => {
    await seedMediaReady()
    const boom = { extract: async () => { throw new Error('provider 500') } }
    await extractTick(boom)
    let row = await getPlay('p1')
    expect(row.status).toBe('media_ready')
    expect(row.attempts).toBe(1)
    expect(row.error).toContain('provider 500')
    // Exhaust the budgeted attempts (max_attempts=4) — each retry is due after backoff.
    for (let i = 0; i < 3; i++) {
      await pg.db.update(plays).set({ nextAttemptAt: NOW, claimedAt: null }).where(eq(plays.id, 'p1'))
      await extractTick(boom)
    }
    row = await getPlay('p1')
    expect(row.status).toBe('failed') // terminal — parked for a human, not retried forever
    expect(row.attempts).toBe(4)
    // A crash between the billed call and reconciliation must NOT undercount the meter: each
    // attempt persisted its worst-case reservation row (null promptVersion = the crash marker).
    const runs = await pg.db.select().from(playExtractions)
    expect(runs).toHaveLength(4)
    for (const r of runs) {
      expect(r.costUsd).toBeGreaterThan(0)
      expect(r.promptVersion).toBeNull()
    }
  })

  it('shutdown mid-LLM-call: claim released unchanged, the unbilled reservation dropped', async () => {
    await seedMediaReady()
    const stop = new AbortController()
    const analyzer = {
      extract: async (_i: unknown, _t: unknown, opts?: { signal?: AbortSignal }) => {
        stop.abort() // SIGTERM lands mid-flight
        throw Object.assign(new Error('aborted'), { name: 'AbortError', cause: opts?.signal })
      },
    }
    const stats = await extractTick(analyzer, { signal: stop.signal })
    expect(stats).toMatchObject({ retrying: 1, extracted: 0, failed: 0 })
    const row = await getPlay('p1')
    expect(row.status).toBe('media_ready')
    expect(row.attempts).toBe(0) // a deploy is not a fault
    expect(row.claimedAt).toBeNull()
    expect(await pg.db.select().from(playExtractions)).toHaveLength(0) // aborted = not billed = not metered
  })

  it('no analyzer wired (no OPENAI_API_KEY): media_ready rows rest untouched', async () => {
    await seedMediaReady()
    const stats = await extractTick(undefined)
    expect(stats).toMatchObject({ claimed: 0, extracted: 0 })
    expect((await getPlay('p1')).status).toBe('media_ready')
  })
})

describe('unbilled provider rejections (P2 live finding: restricted key, 403 missing scope)', () => {
  it('a 403 drops the attempt reservation (never billed) but still counts as a stage fault', async () => {
    await capturePlays(pg.db, [rawPlay('p1')], playsCfg(), NOW)
    await pg.db.update(plays)
      .set({ status: 'media_ready', mediaStatus: 'none', media: null, nextAttemptAt: NOW })
      .where(eq(plays.id, 'p1'))
    const rejected = {
      extract: async () => {
        throw new APICallError({
          message: 'Missing scopes: api.responses.write', url: 'https://api.openai.com/v1/responses',
          requestBodyValues: {}, statusCode: 403, responseHeaders: {}, responseBody: '',
        })
      },
    }
    await runQueueTick({
      db: pg.db, config: playsCfg(), clock: () => NOW, analyzer: rejected, isListedTicker: () => true,
    })
    const row = await getPlay('p1')
    expect(row.attempts).toBe(1) // still a fault — backoff applies
    expect(row.status).toBe('media_ready')
    expect(await pg.db.select().from(playExtractions)).toHaveLength(0) // rejected ≠ billed ≠ metered
  })
})
