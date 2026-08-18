import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Response } from 'undici'
import { afterAll, describe, expect, it } from 'vitest'

import type { PlayRow } from '@wsb/shared'

import type { PlaysConfig } from '../src/config'
import { galleryImages, inlineImages, runMediaStage, type Fetcher, type MediaDeps } from '../src/plays/media'

// P1 media resolver (plays-plan §3 / product §3): gallery ORDER from gallery_data.items (not the
// unordered media_metadata), mime→ext, inline self-post images, download caps, and the
// transient-vs-permanent failure split that drives invariant P7's retry-then-degrade.

const TMP = join(tmpdir(), `wsb-plays-media-${process.pid}`)
afterAll(async () => { await rm(TMP, { recursive: true, force: true }) })

const cfg = (over: Partial<PlaysConfig> = {}): PlaysConfig => ({
  enabled: true, flairs: new Set(['Gain']), queueIntervalSeconds: 60, maxAttempts: 4,
  leaseSeconds: 600, mediaRetrySeconds: 600, maxImagesStored: 20, maxImageBytes: 10 * 1024 * 1024,
  redditUserAgent: 'test-ua', mediaDir: TMP, ...over,
})

/** Minimal PlayRow with just the fields media.ts reads; the rest are nulls. */
const play = (over: Partial<PlayRow>): PlayRow => ({
  id: 'post1', createdUtc: null, capturedAt: null, publishedAt: null, author: null, flair: null,
  title: null, selftext: null, permalink: null, url: null, isGallery: false, media: null,
  mediaStatus: 'pending', raw: {}, score: null, numComments: null, removed: null, refreshedAt: null,
  status: 'captured', attempts: 0, nextAttemptAt: null, claimedAt: null, error: null,
  mediaRetryUntil: null, currentExtractionAt: null, currentInterpretationAt: null, primaryTicker: null,
  category: null, tags: null, confidence: null, pnlAbs: null, pnlPct: null, realized: null,
  summary: null, tldr: null, extractorVersion: null, interpreterVersion: null, taxonomyVersion: null,
  trackStatus: null, trackUntil: null, ...over,
})

/** Route-table fake fetch: URL → Response factory (a factory, so each retry gets a fresh body). */
const fakeFetch = (routes: Record<string, () => Response>): { calls: string[]; fetch: Fetcher } => {
  const calls: string[] = []
  const fetch = (async (input: unknown) => {
    const url = String(input)
    calls.push(url)
    const make = routes[url]
    if (!make) return new Response('not routed', { status: 404 })
    return make()
  }) as unknown as Fetcher
  return { calls, fetch }
}

const deps = (fetch: Fetcher, over: Partial<MediaDeps> = {}): MediaDeps =>
  ({ config: cfg(), fetchImpl: fetch, sleep: async () => {}, ...over })

const galleryPostData = {
  gallery_data: { items: [{ media_id: 'img_b' }, { media_id: 'img_a' }, { media_id: 'vid_c' }, { media_id: 'img_d' }] },
  media_metadata: {
    // Deliberately keyed in a DIFFERENT order than gallery_data — order must come from gallery_data.
    img_a: { status: 'valid', e: 'Image', m: 'image/png' },
    img_b: { status: 'valid', e: 'Image', m: 'image/jpg' },
    vid_c: { status: 'valid', e: 'AnimatedImage', m: 'image/gif' }, // non-Image → skipped
    img_d: { status: 'failed', e: 'Image', m: 'image/jpg' }, // not valid → skipped
  },
}

describe('galleryImages', () => {
  it('orders by gallery_data.items and maps mime→ext; skips non-image/invalid entries', () => {
    expect(galleryImages(galleryPostData, 20)).toEqual([
      { order: 0, url: 'https://i.redd.it/img_b.jpg', ext: 'jpg' },
      { order: 1, url: 'https://i.redd.it/img_a.png', ext: 'png' },
    ])
  })

  it('caps to the FIRST N in gallery order, never an arbitrary subset', () => {
    const imgs = galleryImages(galleryPostData, 1)
    expect(imgs).toHaveLength(1)
    expect(imgs[0]!.url).toBe('https://i.redd.it/img_b.jpg') // the first gallery image = the screenshot
  })

  it('returns [] when gallery_data is missing (removed post JSON)', () => {
    expect(galleryImages({ media_metadata: galleryPostData.media_metadata }, 20)).toEqual([])
  })
})

describe('inlineImages', () => {
  const raw = {
    selftext: 'proof: https://preview.redd.it/late9.png?width=100&amp;s=sig9 then https://preview.redd.it/early1.jpg?width=200&amp;s=sig1',
    media_metadata: {
      // Keyed opposite to selftext appearance; selftext order must win. Note "late9" appears FIRST.
      early1: { status: 'valid', e: 'Image', m: 'image/jpg' },
      late9: { status: 'valid', e: 'Image', m: 'image/png' },
    },
  }

  it('orders by first appearance in the selftext and prefers the signed preview URL (unescaped)', () => {
    expect(inlineImages(raw, 20)).toEqual([
      { order: 0, url: 'https://preview.redd.it/late9.png?width=100&s=sig9', ext: 'png' },
      { order: 1, url: 'https://preview.redd.it/early1.jpg?width=200&s=sig1', ext: 'jpg' },
    ])
  })

  it('falls back to i.redd.it for ids not embedded in the selftext', () => {
    const imgs = inlineImages({ selftext: '', media_metadata: { solo1: { status: 'valid', e: 'Image', m: 'image/jpg' } } }, 20)
    expect(imgs).toEqual([{ order: 0, url: 'https://i.redd.it/solo1.jpg', ext: 'jpg' }])
  })
})

describe('runMediaStage', () => {
  it('direct i.redd.it image: downloads, hashes, archives to <mediaDir>/<id>/<n>.<ext>', async () => {
    const bytes = Buffer.from('fake-jpeg-bytes')
    const { fetch } = fakeFetch({ 'https://i.redd.it/xyz789.jpeg': () => new Response(bytes, { status: 200 }) })
    const r = await runMediaStage(play({ id: 'direct1', url: 'https://i.redd.it/xyz789.jpeg' }), deps(fetch))

    expect(r.none).toBe(false)
    expect(r.retryable).toBe(false)
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toMatchObject({
      order: 0, path: 'direct1/0.jpg', ext: 'jpg', bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sourceUrl: 'https://i.redd.it/xyz789.jpeg',
    })
    expect(await readFile(join(TMP, 'direct1/0.jpg'))).toEqual(bytes)
  })

  it('gallery: resolves via the reddit post JSON, preserving gallery order on disk', async () => {
    const { fetch, calls } = fakeFetch({
      'https://www.reddit.com/r/wsb/comments/g1/x/.json?raw_json=1': () =>
        new Response(JSON.stringify([{ data: { children: [{ data: galleryPostData }] } }]), { status: 200 }),
      'https://i.redd.it/img_b.jpg': () => new Response(Buffer.from('b-bytes'), { status: 200 }),
      'https://i.redd.it/img_a.png': () => new Response(Buffer.from('a-bytes'), { status: 200 }),
    })
    const r = await runMediaStage(
      play({ id: 'gal1', isGallery: true, permalink: '/r/wsb/comments/g1/x/' }), deps(fetch))

    expect(r.retryable).toBe(false)
    expect(r.items.map((i) => i.path)).toEqual(['gal1/0.jpg', 'gal1/1.png'])
    expect(calls[0]).toContain('.json?raw_json=1') // resolution before downloads
  })

  it('gallery post-JSON 403 is PERMANENT (deleted/blocked) — empty, not retryable', async () => {
    const { fetch, calls } = fakeFetch({
      'https://www.reddit.com/r/wsb/comments/g2/x/.json?raw_json=1': () => new Response('', { status: 403 }),
    })
    const r = await runMediaStage(play({ id: 'gal2', isGallery: true, permalink: '/r/wsb/comments/g2/x/' }), deps(fetch))
    expect(r).toMatchObject({ items: [], retryable: false, none: false })
    expect(calls).toHaveLength(1) // no in-stage retry on a permanent failure
  })

  it('gallery post-JSON 5xx is TRANSIENT — retried in-stage, then surfaced retryable', async () => {
    const { fetch, calls } = fakeFetch({
      'https://www.reddit.com/r/wsb/comments/g3/x/.json?raw_json=1': () => new Response('', { status: 503 }),
    })
    const r = await runMediaStage(play({ id: 'gal3', isGallery: true, permalink: '/r/wsb/comments/g3/x/' }), deps(fetch))
    expect(r).toMatchObject({ items: [], retryable: true, none: false })
    expect(calls).toHaveLength(3) // 1 + MAX_FETCH_RETRIES in-stage attempts
  })

  it('image 404 is permanent (media gone), image 429 keeps the play retryable', async () => {
    const { fetch } = fakeFetch({ 'https://i.redd.it/gone1.jpg': () => new Response('', { status: 404 }) })
    const gone = await runMediaStage(play({ id: 'gone', url: 'https://i.redd.it/gone1.jpg' }), deps(fetch))
    expect(gone).toMatchObject({ items: [], retryable: false, none: false })

    const { fetch: f429 } = fakeFetch({ 'https://i.redd.it/slow1.jpg': () => new Response('', { status: 429 }) })
    const throttled = await runMediaStage(play({ id: 'slow', url: 'https://i.redd.it/slow1.jpg' }), deps(f429))
    expect(throttled).toMatchObject({ items: [], retryable: true, none: false })
  })

  it('oversize images are skipped permanently — Content-Length up front, streamed cap without it', async () => {
    const big = Buffer.alloc(64, 1)
    const { fetch } = fakeFetch({
      'https://i.redd.it/big1.jpg': () => new Response(big, { status: 200, headers: { 'content-length': '64' } }),
      'https://i.redd.it/big2.jpg': () => new Response(big, { status: 200 }), // no length header → cap mid-stream
    })
    const d = deps(fetch)
    d.config = cfg({ maxImageBytes: 32 })
    const r1 = await runMediaStage(play({ id: 'big1', url: 'https://i.redd.it/big1.jpg' }), d)
    expect(r1).toMatchObject({ items: [], retryable: false })
    const r2 = await runMediaStage(play({ id: 'big2', url: 'https://i.redd.it/big2.jpg' }), d)
    expect(r2).toMatchObject({ items: [], retryable: false })
  })

  it('a play with no resolvable media reports none (text-only by construction)', async () => {
    const { fetch, calls } = fakeFetch({})
    const r = await runMediaStage(play({ id: 'text1', url: 'https://example.com/article' }), deps(fetch))
    expect(r).toMatchObject({ items: [], retryable: false, none: true })
    expect(calls).toEqual([]) // no network for text-only
  })

  it('partial gallery: archives what succeeds, stays retryable while an image fails transiently', async () => {
    const { fetch } = fakeFetch({
      'https://www.reddit.com/r/wsb/comments/g4/x/.json?raw_json=1': () =>
        new Response(JSON.stringify([{ data: { children: [{ data: galleryPostData }] } }]), { status: 200 }),
      'https://i.redd.it/img_b.jpg': () => new Response(Buffer.from('b-bytes'), { status: 200 }),
      'https://i.redd.it/img_a.png': () => new Response('', { status: 503 }),
    })
    const r = await runMediaStage(play({ id: 'gal4', isGallery: true, permalink: '/r/wsb/comments/g4/x/' }), deps(fetch))
    expect(r.items.map((i) => i.path)).toEqual(['gal4/0.jpg'])
    expect(r.retryable).toBe(true) // the queue retries within media_retry_until; archiving is idempotent
  })
})
