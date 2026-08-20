import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  cycleRuns, empiricalFeatures, marketMovers, mentions, playExtractions, playInterpretations, plays,
  signals, type PlayMediaItem, type PlayRow,
} from '@wsb/shared'
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
import type { InterpretRequest } from '../src/plays/analyzer'
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
  captureDelaySeconds: 0, // delay/thin-text semantics are pinned in plays.capture.test.ts; 0 keeps fixtures simple
  textOnlyMinChars: 0,
  maxAttempts: 4, leaseSeconds: 600, mediaRetrySeconds: 600, maxImagesStored: 20, maxImagesLlm: 8,
  maxImageBytes: 10 * 1024 * 1024, maxRequestBytes: 24 * 1024 * 1024, redditUserAgent: 'test-ua',
  mediaDir: TMP,
  llm: {
    provider: 'openai', extractModel: 'test-model', interpretModel: 'test-model', maxPlaysPerTick: 5,
    maxOutputTokens: 2000, dailyBudgetUsd: 5,
    prices: { 'test-model': { input: 1, output: 4 } }, // $/Mtok — usable by default; tests override to refuse
  },
  herd: { lookbackHours: 72, minAuthors: 5 },
  heatStalenessSeconds: 6 * 3600,
  ...over,
})

/** The P2-stage tests never reach interpret (downstream-first tick ordering) — a stub that trips
 *  loudly if that ever stops being true. */
const interpretNotExpected = async (): Promise<never> => {
  throw new Error('interpret called — not expected in this test')
}

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
      interpret: interpretNotExpected,
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

  it('media_ready → discarded on a zero-position extraction: terminal tombstone, no interpret call', async () => {
    await seedMediaReady()
    const analyzer = {
      extract: async () => ({
        extraction: { ...llmOut(), positions: [], screenshot_kind: 'chart' as const },
        usage: { inputTokens: 1000, outputTokens: 50 },
        model: 'test-model', promptVersion: 'extract-prompt-v1',
      }),
      interpret: interpretNotExpected, // a no-play post must never burn the second LLM call
    }
    const stats = await extractTick(analyzer)
    expect(stats).toMatchObject({ extracted: 0, discarded: 1, failed: 0 })

    const row = await getPlay('p1')
    expect(row.status).toBe('discarded')
    expect(row.nextAttemptAt).toBeNull() // terminal — never due again
    expect(row.claimedAt).toBeNull()
    const runs = await pg.db.select().from(playExtractions)
    expect(runs).toHaveLength(1) // the paid run stays on the meter + audit trail
    expect(row.currentExtractionAt).toBe(runs[0]!.runAt)

    // the tombstone is invisible to every later tick (and dedupes re-delivery via ON CONFLICT)
    const stats2 = await extractTick(analyzer)
    expect(stats2).toMatchObject({ claimed: 0 })
    await capturePlays(pg.db, [rawPlay('p1')], playsCfg(), NOW + 300)
    expect((await getPlay('p1')).status).toBe('discarded')
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
    const boom = { extract: async () => { throw new Error('provider 500') }, interpret: interpretNotExpected }
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
      interpret: interpretNotExpected,
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
      interpret: interpretNotExpected,
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

describe('interpret/publish stage (P3): evidence + herd gate + the one-update publish on real Postgres', () => {
  const EXT_RUN = NOW * 1000
  const validatedLeg = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    ticker: 'NVDA', instrument: 'call', side: 'long', quantity: 2, avg_price: 3.5,
    strike: 150, expiry: '2026-09-18', cost_basis: 700, current_value: 1200, pnl_abs: 500,
    pnl_pct: 71.4, realized: false, opened_at: null, currency: null, confidence: 0.9,
    field_confidence: null, position_id: 'nvda:call:long:150:2026-09-18',
    ticker_outcome: 'validated', arithmetic_ok: true,
    ...over,
  })
  const storedExtraction = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    schema_version: 'extract-schema-v1', screenshot_kind: 'single_position', broker: 'Robinhood',
    positions: [validatedLeg()], notes: null, direction: 'bullish', confidence: 0.85,
    model_confidence: 0.85, ...over,
  })

  const seedExtracted = async (extraction = storedExtraction(), id = 'p1'): Promise<void> => {
    await capturePlays(pg.db, [rawPlay(id)], playsCfg(), NOW)
    await pg.db.insert(playExtractions).values({
      playId: id, runAt: EXT_RUN, model: 'test-model',
      promptVersion: 'extract-prompt-v4/extract-schema-v1',
      output: extraction, tokensIn: 100, tokensOut: 50, costUsd: 0.001,
    })
    await pg.db.update(plays)
      .set({ status: 'extracted', mediaStatus: 'none', currentExtractionAt: EXT_RUN, nextAttemptAt: NOW })
      .where(eq(plays.id, id))
  }

  /** Recording fake: captures each InterpretRequest so tests can assert what the seam SAW. */
  const fakeInterpreter = (over: Record<string, unknown> = {}) => {
    const reqs: InterpretRequest[] = []
    return {
      reqs,
      extract: async (): Promise<never> => { throw new Error('extract not expected in this test') },
      interpret: async (req: InterpretRequest) => {
        reqs.push(req)
        return {
          interpretation: {
            thesis: 'Bought NVDA calls.', outcome: 'Up 71% at post time.', context: null,
            category: 'high-risk-high-reward' as const, tags: ['gain-porn'],
            summary: 'A leveraged call bet on NVDA, well in profit when posted.',
            tldr: 'NVDA calls up 71%.', confidence: 0.8, ...over,
          },
          usage: { inputTokens: 2000, outputTokens: 300 },
          model: 'test-model', promptVersion: 'interpret-prompt-v1',
        }
      },
    }
  }

  const interpretTick = (analyzer: QueueDeps['analyzer'], over: Partial<QueueDeps> = {}): ReturnType<typeof runQueueTick> =>
    runQueueTick({
      db: pg.db, config: playsCfg(), clock: () => NOW, analyzer,
      isListedTicker: (t) => t === 'NVDA', windowSeconds: 3600, ...over,
    })

  it('extracted → published: ONE row update carries status+published_at+pointer+board fields; the child row holds evidence and versions', async () => {
    await seedExtracted()
    const analyzer = fakeInterpreter()
    const stats = await interpretTick(analyzer)
    expect(stats).toMatchObject({ published: 1, parked: 0, failed: 0 })
    expect(analyzer.reqs).toHaveLength(1)
    // no herd mentions seeded → the gate is CLOSED and the seam saw it closed (invariant P4)
    expect(analyzer.reqs[0]!.allowHerd).toBe(false)
    expect(analyzer.reqs[0]!.evidence.anchor_basis).toBe('post_time') // no opened_at → weaker badge

    const row = await getPlay('p1')
    expect(row.status).toBe('published')
    expect(row.publishedAt).toBe(NOW)
    expect(row.claimedAt).toBeNull()
    expect(row).toMatchObject({
      primaryTicker: 'NVDA', category: 'high-risk-high-reward', tags: ['gain-porn'],
      confidence: 0.85, // the EXTRACTION's derived confidence — not the interpretation self-report
      pnlAbs: 500, realized: false,
      tldr: 'NVDA calls up 71%.',
      extractorVersion: 'extract-prompt-v4/extract-schema-v1',
      interpreterVersion: 'interpret-prompt-v1/interpret-schema-v1',
      taxonomyVersion: 'taxonomy-v1',
    })
    expect(row.pnlPct).toBeCloseTo((500 / 700) * 100, 6)

    const runs = await pg.db.select().from(playInterpretations)
    expect(runs).toHaveLength(1)
    expect(row.currentInterpretationAt).toBe(runs[0]!.runAt) // the pointer names the winning run
    expect(runs[0]).toMatchObject({
      playId: 'p1', model: 'test-model', promptVersion: 'interpret-prompt-v1/interpret-schema-v1',
      tokensIn: 2000, tokensOut: 300,
    })
    // 2000 in @ $1/M + 300 out @ $4/M (playsCfg test prices) = $0.0032, reconciled from usage
    expect(runs[0]!.costUsd).toBeCloseTo(0.0032, 9)
    const evidence = runs[0]!.evidence as { evidence_version: string; ticker: string; herd: { eligible: boolean } }
    expect(evidence.evidence_version).toBe('evidence-v1')
    expect(evidence.ticker).toBe('NVDA')
    const output = runs[0]!.output as { schema_version: string; taxonomy_version: string; herd_allowed: boolean }
    expect(output).toMatchObject({
      schema_version: 'interpret-schema-v1', taxonomy_version: 'taxonomy-v1', herd_allowed: false,
    })
  })

  it('herd gate on real rows: 5 distinct same-direction post authors open it; own author/own post/comments/wrong direction/[deleted]/stale/off-flair never count', async () => {
    await seedExtracted()
    const at = NOW - 3600
    await pg.db.insert(mentions).values([
      // the herd: 5 distinct authors, posts, plays flair, same (bull) direction, inside 72 h
      ...['a1', 'a2', 'a3', 'a4', 'a5'].map((author, i) => ({
        ticker: 'NVDA', thingId: `h${i}`, thingType: 'post', createdUtc: at, author, flair: 'Gain', direction: 'bull',
      })),
      // pollution — none of these may count:
      { ticker: 'NVDA', thingId: 'own', thingType: 'post', createdUtc: at, author: 'degen', flair: 'Gain', direction: 'bull' }, // the play's own author
      { ticker: 'NVDA', thingId: 'p1', thingType: 'post', createdUtc: at, author: 'x9', flair: 'Gain', direction: 'bull' }, // the play's own post
      { ticker: 'NVDA', thingId: 'c1', thingType: 'comment', createdUtc: at, author: 'c1', flair: null, direction: 'bull' }, // comment, not a post
      { ticker: 'NVDA', thingId: 'b1', thingType: 'post', createdUtc: at, author: 'b1', flair: 'Loss', direction: 'bear' }, // wrong direction
      { ticker: 'NVDA', thingId: 'd1', thingType: 'post', createdUtc: at, author: '[deleted]', flair: 'Gain', direction: 'bull' },
      { ticker: 'NVDA', thingId: 'o1', thingType: 'post', createdUtc: NOW - 73 * 3600, author: 'old1', flair: 'Gain', direction: 'bull' }, // outside lookback
      { ticker: 'NVDA', thingId: 'dd', thingType: 'post', createdUtc: at, author: 'dd1', flair: 'DD', direction: 'bull' }, // not a plays flair
    ])
    const analyzer = fakeInterpreter({ category: 'herd-following', tags: ['herd'] })
    await interpretTick(analyzer)
    expect(analyzer.reqs[0]!.allowHerd).toBe(true)
    expect(analyzer.reqs[0]!.evidence.herd).toMatchObject({
      direction: 'bull', distinct_authors: 5, threshold: 5, eligible: true,
    })
    const row = await getPlay('p1')
    expect(row.category).toBe('herd-following') // gate open → the label is legitimate
    // trailing counts see ALL mentions (they measure attention, not the herd)
    expect(analyzer.reqs[0]!.evidence.radar!.mentions_72h).toBeGreaterThanOrEqual(10)
  })

  it('radar heat reads the last COMPLETE window and honors the staleness bound', async () => {
    await seedExtracted()
    // Three cycle_runs rows: WS is the newest (still being rewritten) → the complete one is WS−3600.
    await pg.db.insert(cycleRuns).values([
      { windowStart: WS - 7200, generatedAt: NOW }, { windowStart: WS - 3600, generatedAt: NOW },
      { windowStart: WS, generatedAt: NOW },
    ])
    await pg.db.insert(empiricalFeatures).values({
      ticker: 'NVDA', windowStart: WS - 3600, sov: 0.4, hE: 0.9, mentions: 12, authors: 7,
    })
    await pg.db.insert(signals).values({ ticker: 'NVDA', windowStart: WS - 3600, rank: 2 })
    const analyzer = fakeInterpreter()
    await interpretTick(analyzer)
    expect(analyzer.reqs[0]!.evidence.radar).toMatchObject({
      window_start: WS - 3600,
      heat: { rank: 2, sov: 0.4, h_e: 0.9, mentions: 12, authors: 7 },
      note: null,
    })

    // Staleness: only windows ≥ 10 h older than the anchor exist → "heat evidence unavailable".
    await pg.reset()
    await seedExtracted()
    await pg.db.insert(cycleRuns).values([
      { windowStart: WS - 12 * 3600, generatedAt: NOW }, { windowStart: WS - 11 * 3600, generatedAt: NOW },
    ])
    const stale = fakeInterpreter()
    await interpretTick(stale)
    expect(stale.reqs[0]!.evidence.radar!.heat).toBeNull()
    expect(stale.reqs[0]!.evidence.radar!.window_start).toBeNull()
    expect(stale.reqs[0]!.evidence.radar!.note).toContain('unavailable')
  })

  it('market evidence rides daily bars + persisted movers; a dead provider degrades, never crashes the stage', async () => {
    await seedExtracted()
    await pg.db.insert(marketMovers).values({ ts: NOW - 600, kind: 'gainer', rank: 3, symbol: 'NVDA' })
    // The post lands at 01:01 Z (evening US of the PRIOR calendar day): the last session UNDERWAY
    // by post time is the previous day's — the same-UTC-date bar (stamped ~05 Z, session not yet
    // open) must NOT carry the returns.
    const day = Math.floor((WS + 10) / 86400) * 86400
    const closes = [100, 101, 102, 103, 104, 105, 110]
    const volumes = [1, 1, 1, 1, 500, 1000, 2000]
    const market = {
      name: 'fake', snapshots: async () => new Map(), screeners: async () => [], close: async () => {},
      dailyBars: async () => closes.map((c, i) => ({ ts: day - (6 - i) * 86400 + 5 * 3600, close: c, volume: volumes[i]! })),
    }
    const analyzer = fakeInterpreter()
    await interpretTick(analyzer, { market })
    const ev = analyzer.reqs[0]!.evidence.market!
    expect(ev.movers).toEqual(['gainer'])
    expect(ev.day_ret).toBeCloseTo((105 - 104) / 104, 9)
    expect(ev.five_day_ret).toBeCloseTo((105 - 100) / 100, 9)
    expect(ev.rvol).toBeCloseTo(2, 9)
    expect(ev.rvol_conf).toBe('low')

    // Provider failure → note + nulls, the play still publishes (evidence degrades, stage survives).
    await pg.reset()
    await seedExtracted()
    const broken = {
      ...market, dailyBars: async (): Promise<never> => { throw new Error('alpaca down') },
    }
    const analyzer2 = fakeInterpreter()
    const stats = await interpretTick(analyzer2, { market: broken })
    expect(stats).toMatchObject({ published: 1, failed: 0 })
    expect(analyzer2.reqs[0]!.evidence.market!.day_ret).toBeNull()
    expect(analyzer2.reqs[0]!.evidence.market!.note).toContain('market fetch failed')
  })

  it('non-equity primary ticker: radar/herd/market structurally absent, herd unassignable, still published', async () => {
    await seedExtracted(storedExtraction({
      positions: [validatedLeg({ ticker: 'SPX', ticker_outcome: 'known_non_equity' })],
    }))
    const analyzer = fakeInterpreter()
    const stats = await interpretTick(analyzer)
    expect(stats).toMatchObject({ published: 1 })
    const ev = analyzer.reqs[0]!.evidence
    expect(ev.radar).toBeNull()
    expect(ev.herd).toBeNull()
    expect(ev.market).toBeNull()
    expect(ev.note).toContain('structurally absent')
    expect(analyzer.reqs[0]!.allowHerd).toBe(false)
    expect((await getPlay('p1')).primaryTicker).toBe('SPX')
  })

  it('budget refusal parks the play — no reservation, no interpret call', async () => {
    await seedExtracted()
    await pg.db.insert(playExtractions).values({
      playId: 'p1', runAt: EXT_RUN - 1000, model: 'test-model', promptVersion: 'x',
      output: {}, tokensIn: 1, tokensOut: 1, costUsd: 4.999,
    })
    const analyzer = fakeInterpreter()
    const stats = await interpretTick(analyzer)
    expect(stats).toMatchObject({ published: 0, parked: 1 })
    expect(analyzer.reqs).toHaveLength(0)
    expect((await getPlay('p1')).status).toBe('extracted')
    expect(await pg.db.select().from(playInterpretations)).toHaveLength(0)
  })

  it('an interpret crash keeps its reservation on the meter (fail-closed), with the null-prompt crash marker', async () => {
    await seedExtracted()
    const boom = {
      extract: interpretNotExpected,
      interpret: async (): Promise<never> => { throw new Error('provider 500') },
    }
    await interpretTick(boom)
    const row = await getPlay('p1')
    expect(row.status).toBe('extracted')
    expect(row.attempts).toBe(1)
    const runs = await pg.db.select().from(playInterpretations)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.promptVersion).toBeNull()
    expect(runs[0]!.costUsd).toBeGreaterThan(0)
    expect(runs[0]!.evidence).not.toBeNull() // the crash still leaves an auditable evidence record
  })

  it('an unbilled rejection (403) drops the reservation but still counts as a stage fault', async () => {
    await seedExtracted()
    const rejected = {
      extract: interpretNotExpected,
      interpret: async (): Promise<never> => {
        throw new APICallError({
          message: 'Missing scopes', url: 'x', requestBodyValues: {},
          statusCode: 403, responseHeaders: {}, responseBody: '',
        })
      },
    }
    await interpretTick(rejected)
    const row = await getPlay('p1')
    expect(row.attempts).toBe(1)
    expect(row.status).toBe('extracted')
    expect(await pg.db.select().from(playInterpretations)).toHaveLength(0)
  })

  it('max_plays_per_tick is ONE budget across both LLM stages — never 2× the configured calls', async () => {
    await seedExtracted() // p1 at extracted
    await capturePlays(pg.db, [rawPlay('p2')], playsCfg(), NOW)
    await pg.db.update(plays)
      .set({ status: 'media_ready', mediaStatus: 'none', media: null, nextAttemptAt: NOW })
      .where(eq(plays.id, 'p2'))
    const analyzer = fakeInterpreter()
    const stats = await interpretTick(analyzer, { config: playsCfg({ llm: { ...playsCfg().llm, maxPlaysPerTick: 1 } }) })
    // The single slot goes to the downstream (extracted) row; p2 waits for the next tick.
    expect(stats).toMatchObject({ published: 1, extracted: 0 })
    expect((await getPlay('p2')).status).toBe('media_ready')
  })

  it('a broken pointer (missing extraction row) is a stage fault, not a silent publish', async () => {
    await seedExtracted()
    await pg.db.update(plays).set({ currentExtractionAt: 12345 }).where(eq(plays.id, 'p1'))
    const analyzer = fakeInterpreter()
    await interpretTick(analyzer)
    const row = await getPlay('p1')
    expect(row.status).toBe('extracted')
    expect(row.attempts).toBe(1)
    expect(row.error).toContain('missing')
    expect(analyzer.reqs).toHaveLength(0)
  })
})
