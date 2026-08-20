import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Response } from 'undici'
import { afterAll, describe, expect, it } from 'vitest'

import type { PlayRow } from '@wsb/shared'

import type { PlaysConfig } from '../src/config'
import { galleryImages, galleryMetadataComplete, inlineImages, runMediaStage, type Fetcher, type MediaDeps } from '../src/plays/media'

// P1 media resolver (plays-plan §3 / product §3): gallery ORDER from gallery_data.items (not the
// unordered media_metadata), mime→ext, inline self-post images, download caps, and the
// transient-vs-permanent failure split that drives invariant P7's retry-then-degrade.

const TMP = join(tmpdir(), `wsb-plays-media-${process.pid}`)
afterAll(async () => { await rm(TMP, { recursive: true, force: true }) })

const cfg = (over: Partial<PlaysConfig> = {}): PlaysConfig => ({
  enabled: true, flairs: new Set(['Gain']), queueIntervalSeconds: 60,
  captureDelaySeconds: 0, textOnlyMinChars: 0, maxAttempts: 4,
  leaseSeconds: 600, mediaRetrySeconds: 600, maxImagesStored: 20, maxImagesLlm: 8,
  maxImageBytes: 10 * 1024 * 1024, maxRequestBytes: 24 * 1024 * 1024,
  redditUserAgent: 'test-ua', mediaDir: TMP,
  llm: {
    provider: 'openai', extractModel: 'test-model', interpretModel: 'test-model', maxPlaysPerTick: 5,
    maxOutputTokens: 2000, dailyBudgetUsd: 5, prices: {},
  },
  herd: { lookbackHours: 72, minAuthors: 5 },
  heatStalenessSeconds: 6 * 3600,
  ...over,
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

/** Route-table fake fetch: URL → Response factory (a factory, so each retry gets a fresh body).
 *  Honors an already-aborted request signal (throws like undici would) so shutdown paths are testable. */
const fakeFetch = (routes: Record<string, () => Response>): { calls: string[]; fetch: Fetcher } => {
  const calls: string[] = []
  const fetch = (async (input: unknown, init?: { signal?: AbortSignal }) => {
    const url = String(input)
    calls.push(url)
    if (init?.signal?.aborted) throw new Error('This operation was aborted')
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

  it('never throws on malformed archived shapes — a stage crash would burn the play toward terminal failed', () => {
    expect(galleryImages({ gallery_data: { items: 'not-an-array' }, media_metadata: {} }, 20)).toEqual([])
    expect(galleryImages({ gallery_data: { items: [null, 42, {}, { media_id: 7 }] }, media_metadata: {} }, 20)).toEqual([])
    expect(galleryImages({ gallery_data: 'junk', media_metadata: 'junk' }, 20)).toEqual([])
    expect(galleryImages({ gallery_data: { items: [{ media_id: 'x' }] }, media_metadata: { x: 'not-an-object' } }, 20))
      .toEqual([])
  })
})

describe('galleryMetadataComplete', () => {
  it('true when every gallery_data image slot has a metadata entry (skips are then deliberate)', () => {
    expect(galleryMetadataComplete(galleryPostData)).toBe(true)
  })
  it('false when an item has no metadata entry at all — a hole, not a deliberate skip', () => {
    expect(galleryMetadataComplete({
      gallery_data: { items: [{ media_id: 'img_a' }, { media_id: 'hole1' }] },
      media_metadata: { img_a: { status: 'valid', e: 'Image', m: 'image/png' } },
    })).toBe(false)
  })
  it('junk ids and malformed shapes are not holes (they resolve nowhere either way)', () => {
    expect(galleryMetadataComplete({ gallery_data: { items: [null, { media_id: 9 }] }, media_metadata: {} })).toBe(true)
    expect(galleryMetadataComplete({ gallery_data: 'junk', media_metadata: null })).toBe(true)
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

  it('gallery: resolves LOCALLY from the archived raw — the 403-prone reddit JSON is never touched', async () => {
    const { fetch, calls } = fakeFetch({
      'https://i.redd.it/img_b.jpg': () => new Response(Buffer.from('b-bytes'), { status: 200 }),
      'https://i.redd.it/img_a.png': () => new Response(Buffer.from('a-bytes'), { status: 200 }),
    })
    const r = await runMediaStage(
      play({ id: 'gal0', isGallery: true, permalink: '/r/wsb/comments/g0/x/', raw: galleryPostData }), deps(fetch))

    expect(r.retryable).toBe(false)
    expect(r.items.map((i) => i.path)).toEqual(['gal0/0.jpg', 'gal0/1.png'])
    expect(calls.some((u) => u.includes('.json'))).toBe(false) // local metadata → no post-JSON fetch
  })

  it('gallery with PARTIAL archived metadata: tries the JSON fallback, and archives the local subset when it fails', async () => {
    const partialRaw = {
      gallery_data: { items: [{ media_id: 'img_b' }, { media_id: 'hole1' }] }, // hole1 has no metadata entry
      media_metadata: { img_b: { status: 'valid', e: 'Image', m: 'image/jpg' } },
    }
    const { fetch, calls } = fakeFetch({
      'https://www.reddit.com/r/wsb/comments/gp1/x/.json?raw_json=1': () => new Response('', { status: 403 }),
      'https://i.redd.it/img_b.jpg': () => new Response(Buffer.from('b-bytes'), { status: 200 }),
    })
    const r = await runMediaStage(
      play({ id: 'galp1', isGallery: true, permalink: '/r/wsb/comments/gp1/x/', raw: partialRaw }), deps(fetch))

    expect(calls[0]).toContain('.json?raw_json=1') // holes → the fallback IS attempted
    expect(r.retryable).toBe(false)
    expect(r.items.map((i) => i.path)).toEqual(['galp1/0.jpg']) // subset beats text-only (P7)
    expect(r.detail).toContain('archiving the resolvable subset')
  })

  it('gallery FALLBACK: resolves via the reddit post JSON when the raw lacks gallery metadata', async () => {
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

  it('a shutdown abort surfaces as aborted, NEVER as a permanent degrade (P7 — review round 1)', async () => {
    const ac = new AbortController()
    ac.abort()
    const { fetch } = fakeFetch({}) // throws on aborted signal, like undici
    const r = await runMediaStage(
      play({ id: 'shut1', url: 'https://i.redd.it/xyz789.jpeg' }),
      deps(fetch, { signal: ac.signal }),
    )
    expect(r).toMatchObject({ aborted: true, retryable: false, items: [] })

    // The gallery-resolution path too — an aborted post-JSON fetch must not classify as 'gone'.
    const g = await runMediaStage(
      play({ id: 'shut2', isGallery: true, permalink: '/r/wsb/comments/s2/x/' }),
      deps(fetch, { signal: ac.signal }),
    )
    expect(g).toMatchObject({ aborted: true, retryable: false })
  })

  it('reuses prior-attempt items from plays.media instead of re-fetching (manifest survives upstream deletion)', async () => {
    const priorItem = {
      order: 0, path: 'reuse1/0.jpg', ext: 'jpg', bytes: 7, sha256: 'prior-sha',
      sourceUrl: 'https://i.redd.it/xyz789.jpeg',
    }
    const { fetch, calls } = fakeFetch({}) // any fetch would 404 — reuse must not fetch at all
    const r = await runMediaStage(
      play({ id: 'reuse1', url: 'https://i.redd.it/xyz789.jpeg', media: [priorItem] }), deps(fetch))
    expect(r.items).toEqual([priorItem])
    expect(r.retryable).toBe(false)
    expect(calls).toEqual([]) // the file is already on disk; the source may since be deleted
  })

  it('rejects a 200 that is not an image: empty body or non-image content type (CDN error page)', async () => {
    const { fetch } = fakeFetch({
      'https://i.redd.it/empty1.jpg': () => new Response(Buffer.alloc(0), { status: 200 }),
      'https://i.redd.it/html1.jpg': () =>
        new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    })
    const e = await runMediaStage(play({ id: 'empty', url: 'https://i.redd.it/empty1.jpg' }), deps(fetch))
    expect(e).toMatchObject({ items: [], retryable: false }) // permanent — no zero-byte "archives"
    const h = await runMediaStage(play({ id: 'html', url: 'https://i.redd.it/html1.jpg' }), deps(fetch))
    expect(h).toMatchObject({ items: [], retryable: false })
  })

  it('a path-capable play id never escapes the media root (write-path defense in depth)', async () => {
    const { fetch, calls } = fakeFetch({})
    const r = await runMediaStage(play({ id: '../pwn', url: 'https://i.redd.it/xyz789.jpeg' }), deps(fetch))
    expect(r).toMatchObject({ items: [], retryable: false, aborted: false })
    expect(r.detail).toContain('unsafe play id')
    expect(calls).toEqual([]) // refused before any I/O
  })

  it('an exhausted stage budget marks remaining images transient instead of outrunning the lease', async () => {
    const { fetch, calls } = fakeFetch({
      'https://www.reddit.com/r/wsb/comments/g5/x/.json?raw_json=1': () =>
        new Response(JSON.stringify([{ data: { children: [{ data: galleryPostData }] } }]), { status: 200 }),
    })
    const d = deps(fetch)
    d.deadlineAt = Date.now() - 1 // budget already spent before the first image
    const r = await runMediaStage(play({ id: 'gal5', isGallery: true, permalink: '/r/wsb/comments/g5/x/' }), d)
    expect(r).toMatchObject({ items: [], retryable: true })
    expect(calls).toHaveLength(1) // only the resolution fetch; no image downloads started
  })
})
