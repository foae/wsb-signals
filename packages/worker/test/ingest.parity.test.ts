import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { RawCommentInsert, RawPostInsert } from '@wsb/shared'
import { describe, expect, it } from 'vitest'

import { ArcticShiftSource, isRemovedText, normalizeComment, normalizePost } from '../src/ingest'
import { startMockArctic, type Cassette } from './helpers/mockArctic'

// Slice-4 parity gate (porting-spec §4): the ported Arctic-Shift client must reproduce the frozen v0.0.1
// oracle's ingestion boundary EXACTLY —
//   * B2 normalize : raw API dict → RawPost/RawComment (from_arctic field mapping);
//   * poll         : the SAME page cassette that drove the Python `poll` (via a fake httpx client) is
//                    replayed here through a real mock server, asserting identical posts/comments (ids +
//                    fields), newest_utc, `capped`, and `ok`. This makes pagination / stop-conditions /
//                    for-else cap / ok-on-error / window-filter semantics oracle-verified, not re-derived.

type Snake = Record<string, unknown>

const load = (rel: string): any =>
  JSON.parse(readFileSync(new URL(`../../../fixtures/${rel}`, import.meta.url), 'utf8'))

const noop = (): Promise<void> => Promise.resolve() // tests must not actually wait out the 0.3s/2s backoffs

function expectPost(actual: RawPostInsert, exp: Snake): void {
  expect(actual.id).toBe(exp.id)
  expect(actual.createdUtc).toBe(exp.created_utc)
  expect(actual.author ?? null).toBe(exp.author ?? null)
  expect(actual.title ?? null).toBe(exp.title ?? null)
  expect(actual.selftext ?? null).toBe(exp.selftext ?? null)
  expect(actual.removed).toBe(isRemovedText(exp.title, exp.selftext))
  expect(actual.linkFlairText ?? null).toBe(exp.link_flair_text ?? null)
  expect(actual.score ?? null).toBe(exp.score ?? null)
  expect(actual.numComments ?? null).toBe(exp.num_comments ?? null)
  expect(actual.retrievedOn).toBe(exp.retrieved_on)
  expect(actual.source).toBe(exp.source)
}

function expectComment(actual: RawCommentInsert, exp: Snake): void {
  expect(actual.id).toBe(exp.id)
  expect(actual.createdUtc).toBe(exp.created_utc)
  expect(actual.author ?? null).toBe(exp.author ?? null)
  expect(actual.linkId ?? null).toBe(exp.link_id ?? null)
  expect(actual.parentId ?? null).toBe(exp.parent_id ?? null)
  expect(actual.body ?? null).toBe(exp.body ?? null)
  expect(actual.removed).toBe(isRemovedText(exp.body))
  expect(actual.score ?? null).toBe(exp.score ?? null)
  expect(actual.retrievedOn).toBe(exp.retrieved_on)
  expect(actual.source).toBe(exp.source)
}

describe('ingest normalize parity (B2)', () => {
  const fx = load('ingest/normalize.json')
  const retrievedOn: number = fx.retrieved_on

  it.each(Object.keys(fx.posts))('post[%s] from_arctic mapping', (name) => {
    expectPost(normalizePost(fx.posts_raw[name], retrievedOn), fx.posts[name])
  })

  it.each(Object.keys(fx.comments))('comment[%s] from_arctic mapping', (name) => {
    expectComment(normalizeComment(fx.comments_raw[name], retrievedOn), fx.comments[name])
  })
})

describe('ingest poll parity (cassette dual-run)', () => {
  const POLL_DIR = fileURLToPath(new URL('../../../fixtures/ingest/poll/', import.meta.url))
  const POLL = readdirSync(POLL_DIR).filter((f) => f.endsWith('.json')).sort().map((f) => f.replace('.json', ''))

  it.each(POLL)('poll %s matches the oracle', async (name) => {
    const fx = load(`ingest/poll/${name}.json`)
    const exp = fx.expected
    const mock = await startMockArctic(fx.cassette as Cassette)
    try {
      const src = new ArcticShiftSource(mock.baseUrl, fx.subreddit, {
        pageLimit: fx.page_limit,
        maxPages: fx.max_pages,
        sleep: noop,
        // Pin the EXACT oracle no-retry semantics: the §4 contract is "first transient failure ⇒ ok=false".
        // The live worker's retry layer (default 3) is an additive divergence verified in ingest.faults.test.ts;
        // disabling it here keeps this gate testing precisely what the frozen oracle does.
        maxRetries: 0,
      })
      const res = await src.poll(fx.window_seconds, { now: fx.now })

      expect(res.ok, `${name}.ok`).toBe(exp.ok)
      expect(res.capped, `${name}.capped`).toBe(exp.capped)
      expect(res.newestUtc, `${name}.newestUtc`).toBe(exp.newest_utc)
      // ORDER is part of the contract (the walk is deterministic).
      expect(res.posts.map((p) => p.id), `${name}.posts order`).toEqual(exp.posts.map((p: Snake) => p.id))
      expect(res.comments.map((c) => c.id), `${name}.comments order`).toEqual(exp.comments.map((c: Snake) => c.id))
      res.posts.forEach((p, i) => expectPost(p, exp.posts[i]))
      res.comments.forEach((c, i) => expectComment(c, exp.comments[i]))
    } finally {
      await mock.close()
    }
  })
})
