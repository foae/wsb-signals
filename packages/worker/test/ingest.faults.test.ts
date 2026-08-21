import { describe, expect, it } from 'vitest'

import { ArcticShiftSource, ingestionStatus } from '../src/ingest'
import { startMockArctic, type Cassette, type CassettePage } from './helpers/mockArctic'

// Slice-4 behavioral checks (porting-spec §4 + §8 checklist) that are about TIMING and HEADER PARSING
// rather than output values — so they're asserted directly against the §4 constants, not the oracle:
//   * 0.3s inter-page delay + 2s rate-limit backoff fire the right number of times;
//   * the `X-RateLimit-Remaining` parse is STRICT (Python `int()`), NOT lenient (`parseInt`) — a garbage
//     header like "12abc" must NOT trigger a backoff (parseInt would read 12 < 50 and wrongly sleep);
//   * the first request carries `before = now + 5` (the skew buffer) and `after = cutoff`.

const NOW = 1_704_070_800
const WINDOW = 3600
const CUTOFF = NOW - WINDOW // 1_704_067_200

const post = (id: string, created: number): Record<string, unknown> => ({
  id, created_utc: created, author: 'u', title: 't', selftext: '', link_flair_text: null, score: 1, num_comments: 0,
})
const page = (...things: Array<Record<string, unknown>>): CassettePage => ({ status: 200, data: things })
const empty: CassettePage = { status: 200, data: [] }

/** Run a poll with a recording (no-wait) sleep so we can assert which backoffs fired, in order. */
async function runPoll(
  cassette: Cassette,
  opts: { pageLimit?: number; maxPages?: number } = {},
): Promise<{ sleeps: number[]; requests: Array<{ kind: string; url: string }> }> {
  const sleeps: number[] = []
  const sleep = (ms: number): Promise<void> => {
    sleeps.push(ms)
    return Promise.resolve()
  }
  const mock = await startMockArctic(cassette)
  try {
    const src = new ArcticShiftSource(mock.baseUrl, 'wallstreetbets', {
      pageLimit: opts.pageLimit ?? 2,
      maxPages: opts.maxPages ?? 10,
      sleep,
    })
    await src.poll(WINDOW, { now: NOW })
    return { sleeps, requests: mock.requests }
  } finally {
    await mock.close()
  }
}

describe('ingest fault / timing behavior', () => {
  it('sleeps 0.3s between pages (N pages → N−1 inter-page delays), not on a short stop page', async () => {
    const { sleeps } = await runPoll({
      posts: [
        page(post('a', NOW - 10), post('b', NOW - 20)), // full, oldest > cutoff → continue
        page(post('c', NOW - 30), post('d', NOW - 40)), // full → continue
        page(post('e', NOW - 50)), // len 1 < pageLimit → stop (no trailing delay)
      ],
      comments: [empty],
    })
    expect(sleeps).toEqual([300, 300]) // exactly two inter-page delays; no rate-limit backoff
  })

  it('backs off 2s when X-RateLimit-Remaining < 50 (before parsing the page body)', async () => {
    const { sleeps } = await runPoll({
      posts: [
        { status: 200, headers: { 'X-RateLimit-Remaining': '10' }, data: [post('a', NOW - 10), post('b', NOW - 20)] },
        page(post('c', NOW - 30)), // short → stop
      ],
      comments: [empty],
    })
    expect(sleeps).toEqual([2000, 300]) // backoff precedes the inter-page delay
  })

  it('does NOT back off on a non-numeric remaining header (strict int parse — the parseInt landmine)', async () => {
    const { sleeps } = await runPoll({
      // parseInt("12abc") === 12 (< 50) would wrongly sleep; Python int("12abc") raises → ignored.
      posts: [{ status: 200, headers: { 'X-RateLimit-Remaining': '12abc' }, data: [post('a', NOW - 10)] }],
      comments: [empty],
    })
    expect(sleeps).not.toContain(2000)
    expect(sleeps).toEqual([]) // single short page, garbage header → no backoff, no inter-page delay
  })

  it('honors the < 50 boundary exactly: 49 backs off, 50 does not', async () => {
    const at49 = await runPoll({
      posts: [{ status: 200, headers: { 'X-RateLimit-Remaining': '49' }, data: [post('a', NOW - 10)] }],
      comments: [empty],
    })
    const at50 = await runPoll({
      posts: [{ status: 200, headers: { 'X-RateLimit-Remaining': '50' }, data: [post('a', NOW - 10)] }],
      comments: [empty],
    })
    expect(at49.sleeps).toContain(2000)
    expect(at50.sleeps).not.toContain(2000)
  })

  it('first request uses before = now + 5 (skew buffer) and after = cutoff', async () => {
    const { requests } = await runPoll({ posts: [empty], comments: [empty] })
    expect(requests[0]!.kind).toBe('posts') // posts fetched before comments
    expect(requests[0]!.url).toContain(`before=${NOW + 5}`)
    expect(requests[0]!.url).toContain(`after=${CUTOFF}`)
  })
})

// --- retry / backoff on transient page failures (the DELIBERATE DIVERGENCE — porting-spec §4) ----------
// Live, the 1h comment backfill reliably trips Arctic-Shift's `422 "slow down"` throttle + intermittent
// 5xx; the oracle's no-retry contract would discard those whole cycles. These assert the v2 retry layer:
// a transient page failure is retried (bounded, exponential backoff) before the poll is declared partial;
// a genuine non-retryable 4xx still fails fast; a shutdown abort never retries.

/** Poll with a recording sleep, returning the PollResult too (so we can assert ok / items / request count). */
async function pollWith(
  cassette: Cassette,
  opts: { maxRetries?: number; retryBackoffMs?: number; signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ res: Awaited<ReturnType<ArcticShiftSource['poll']>>; sleeps: number[]; requests: Array<{ kind: string; url: string }> }> {
  const sleeps: number[] = []
  const sleep = opts.sleep ?? ((ms: number): Promise<void> => { sleeps.push(ms); return Promise.resolve() })
  const mock = await startMockArctic(cassette)
  try {
    const src = new ArcticShiftSource(mock.baseUrl, 'wallstreetbets', {
      pageLimit: 2,
      maxPages: 10,
      maxRetries: opts.maxRetries ?? 3,
      retryBackoffMs: opts.retryBackoffMs ?? 1000,
      sleep,
    })
    const res = await src.poll(WINDOW, { now: NOW, signal: opts.signal })
    return { res, sleeps, requests: mock.requests }
  } finally {
    await mock.close()
  }
}

const fail = (status: number, body = ''): CassettePage => ({ status, body })

describe('ingest retry / backoff (transient page failures)', () => {
  it('retries a 422 "slow down" throttle, then succeeds (poll stays ok)', async () => {
    const { res, sleeps, requests } = await pollWith({
      posts: [fail(422, '{"error":"Timeout. Maybe slow down a bit"}'), page(post('a', NOW - 10))],
      comments: [empty],
    })
    expect(res.ok).toBe(true)
    expect(res.posts.map((p) => p.id)).toEqual(['a'])
    expect(sleeps[0]).toBe(1000) // one retry backoff before the (short) success page → no inter-page delay
    expect(requests.filter((r) => r.kind === 'posts')).toHaveLength(2) // original + 1 retry
  })

  it('retries a 502, then succeeds', async () => {
    const { res } = await pollWith({
      posts: [fail(502, '<html>bad gateway</html>'), page(post('a', NOW - 10))],
      comments: [empty],
    })
    expect(res.ok).toBe(true)
    expect(res.posts.map((p) => p.id)).toEqual(['a'])
  })

  it('retries a network error (connection reset), then succeeds', async () => {
    const { res, requests } = await pollWith({
      posts: [{ error: 'network' }, page(post('a', NOW - 10))],
      comments: [empty],
    })
    expect(res.ok).toBe(true)
    expect(res.posts.map((p) => p.id)).toEqual(['a'])
    expect(requests.filter((r) => r.kind === 'posts')).toHaveLength(2)
  })

  it('gives up (ok=false) after exhausting maxRetries, with exponential backoff', async () => {
    const { res, sleeps, requests } = await pollWith({
      posts: [fail(503), fail(503), fail(503), fail(503)], // 1 original + 3 retries, all transient
      comments: [empty],
    })
    expect(res.ok).toBe(false)
    expect(sleeps).toEqual([1000, 2000, 4000]) // exponential, capped at 5s (4000 < cap)
    expect(requests.filter((r) => r.kind === 'posts')).toHaveLength(4) // original + 3 retries, then give up
  })

  it('does NOT retry a non-retryable 4xx (404) — fails fast', async () => {
    const { res, sleeps, requests } = await pollWith({
      posts: [fail(404, 'not found'), page(post('a', NOW - 10))], // second page must NEVER be reached
      comments: [empty],
    })
    expect(res.ok).toBe(false)
    expect(sleeps).toEqual([]) // no retry backoff
    expect(requests.filter((r) => r.kind === 'posts')).toHaveLength(1) // single attempt, no retry
  })

  it('maxRetries:0 reproduces the oracle no-retry semantics exactly', async () => {
    const { res, sleeps, requests } = await pollWith({
      posts: [fail(503), page(post('a', NOW - 10))],
      comments: [empty],
    }, { maxRetries: 0 })
    expect(res.ok).toBe(false)
    expect(sleeps).toEqual([])
    expect(requests.filter((r) => r.kind === 'posts')).toHaveLength(1)
  })

  it('a shutdown abort during the backoff stops retrying immediately', async () => {
    const ac = new AbortController()
    // Abort on the first backoff sleep — the client must bail without issuing the retry request.
    const sleep = (): Promise<void> => { ac.abort(); return Promise.resolve() }
    const { res, requests } = await pollWith({
      posts: [fail(503), page(post('a', NOW - 10))],
      comments: [empty],
    }, { signal: ac.signal, sleep })
    expect(res.ok).toBe(false)
    expect(requests.filter((r) => r.kind === 'posts')).toHaveLength(1) // failed once, aborted before retry
  })
})

describe('per-kind ingestion coverage', () => {
  it('does not let a cap hide missing or stale source data', () => {
    expect(ingestionStatus(false, true, NOW, NOW, 60)).toBe('partial')
    expect(ingestionStatus(true, true, null, NOW, 60)).toBe('no-data')
    expect(ingestionStatus(true, true, NOW - 61, NOW, 60)).toBe('stale')
    expect(ingestionStatus(true, true, NOW - 60, NOW, 60)).toBe('capped')
    expect(ingestionStatus(true, false, NOW - 60, NOW, 60)).toBe('fresh')
  })

  it('records independent post and comment coverage bounds', async () => {
    const { res } = await pollWith({
      posts: [page(post('p', NOW - 20))],
      comments: [page({
        id: 'c', created_utc: NOW - 5, author: 'u', body: 'x', link_id: 't3_p', parent_id: 't3_p',
      })],
    })
    expect(res).toMatchObject({
      newestUtc: NOW - 5,
      newestPostUtc: NOW - 20,
      newestCommentUtc: NOW - 5,
      oldestPostUtc: NOW - 20,
      oldestCommentUtc: NOW - 5,
      postPages: 1,
      commentPages: 1,
      postsCapped: false,
      commentsCapped: false,
      postsOk: true,
      commentsOk: true,
    })
  })
})
