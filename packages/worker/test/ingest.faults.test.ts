import { describe, expect, it } from 'vitest'

import { ArcticShiftSource } from '../src/ingest'
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
