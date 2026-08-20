import { describe, expect, it } from 'vitest'

import type { RawThing } from '../src/ingest'
import { initialMediaStatus, isRemovedPost, playRowsFromRaw } from '../src/plays/capture'

// P1 capture mapping (plays-plan §3): flair gate, raw→row mapping, and the capture-time media-shape
// classification. The DB semantics (ON CONFLICT DO NOTHING, never-backwards) live in plays.it.test.ts.

const FLAIRS = new Set(['Gain', 'Loss', 'YOLO', 'Verified Trade'])
const NOW = 1_755_500_000
/** The fixture post is 1000s old — past this delay, so the mapping tests capture it. */
const DELAY_S = 900
const TEXT_MIN = 100

const rawPost = (over: RawThing = {}): RawThing => ({
  id: 'abc123',
  created_utc: 1_755_499_000,
  author: 'degenerate1',
  title: 'NVDA 0DTE gain',
  selftext: '',
  link_flair_text: 'Gain',
  permalink: '/r/wallstreetbets/comments/abc123/nvda_0dte_gain/',
  url: 'https://i.redd.it/xyz789.jpeg',
  is_gallery: false,
  media_metadata: null,
  score: 1,
  num_comments: 0,
  ...over,
})

describe('playRowsFromRaw', () => {
  it('keeps only flair-matched posts and maps the row', () => {
    const { rows } = playRowsFromRaw([
      rawPost(),
      rawPost({ id: 'dd1', link_flair_text: 'DD' }), // wrong flair
      rawPost({ id: 'nf1', link_flair_text: null }), // no flair
      rawPost({ id: 'nf2', link_flair_text: undefined }),
    ], FLAIRS, NOW, DELAY_S, TEXT_MIN)

    expect(rows.map((r) => r.id)).toEqual(['abc123'])
    const r = rows[0]!
    expect(r).toMatchObject({
      id: 'abc123', createdUtc: 1_755_499_000, capturedAt: NOW, author: 'degenerate1', flair: 'Gain',
      title: 'NVDA 0DTE gain', permalink: '/r/wallstreetbets/comments/abc123/nvda_0dte_gain/',
      url: 'https://i.redd.it/xyz789.jpeg', isGallery: false, mediaStatus: 'pending',
      status: 'captured', attempts: 0, nextAttemptAt: NOW, score: 1, numComments: 0,
    })
    expect(r.raw).toEqual(rawPost()) // full dict archived for provenance + reprocessing
  })

  it('drops posts without a usable string id (cannot be deduped or linked)', () => {
    expect(playRowsFromRaw([rawPost({ id: undefined }), rawPost({ id: 42 }), rawPost({ id: '' })], FLAIRS, NOW, DELAY_S, TEXT_MIN).rows)
      .toEqual([])
  })

  it('drops path-capable ids — the id becomes a filesystem/URL segment (media dir, /api/media)', () => {
    const hostile = ['../pwn', 'a/b', 'a.b', 'a b', '.', '..', 'x'.repeat(33)]
    expect(playRowsFromRaw(hostile.map((id) => rawPost({ id })), FLAIRS, NOW, DELAY_S, TEXT_MIN).rows).toEqual([])
  })

  it('tolerates junk-typed fields (nulls, not throws)', () => {
    // junk `url` classifies as text-only → selftext must clear the thin gate for the row to map at all
    const { rows } = playRowsFromRaw(
      [rawPost({ author: 42, title: null, created_utc: 'soon', score: 'many', url: 7, permalink: {}, selftext: 'x'.repeat(TEXT_MIN) })],
      FLAIRS, NOW, DELAY_S, TEXT_MIN,
    )
    expect(rows[0]).toMatchObject({
      id: 'abc123', author: null, title: null, createdUtc: null, score: null, url: null, permalink: null,
    })
  })

  it('skips thin text-only posts (no media, selftext under the floor) — nothing for the LLM', () => {
    const { rows, thin } = playRowsFromRaw([
      rawPost({ id: 'thin1', url: '', media_metadata: null, selftext: 'to the moon' }), // text-only, thin
      rawPost({ id: 'thin2', url: '', media_metadata: null, selftext: `  ${'x'.repeat(TEXT_MIN - 1)}  ` }), // trimmed < floor
      rawPost({ id: 'longtext', url: '', media_metadata: null, selftext: 'x'.repeat(TEXT_MIN) }), // substantial → captured
      rawPost({ id: 'img1', selftext: '' }), // has an image → thin gate does not apply
    ], FLAIRS, NOW, DELAY_S, TEXT_MIN)
    expect(rows.map((r) => r.id)).toEqual(['longtext', 'img1'])
    expect(thin).toBe(2)
  })

  it('defers posts younger than the capture delay (re-delivered later; nothing lost)', () => {
    const { rows, deferred } = playRowsFromRaw([
      rawPost({ id: 'young1', created_utc: NOW - DELAY_S + 1 }), // 1s too young
      rawPost({ id: 'edge1', created_utc: NOW - DELAY_S }), // exactly at the boundary → captured
      rawPost(), // 1000s old → captured
    ], FLAIRS, NOW, DELAY_S, TEXT_MIN)
    expect(rows.map((r) => r.id)).toEqual(['edge1', 'abc123'])
    expect(deferred).toBe(1)
  })

  it('skips posts already removed/deleted upstream — zero media fetches, zero LLM spend', () => {
    const { rows, removed } = playRowsFromRaw([
      rawPost({ id: 'rm1', selftext: '[removed]' }),
      rawPost({ id: 'rm2', selftext: '[deleted]' }),
      rawPost({ id: 'rm3', removed_by_category: 'moderator' }),
      rawPost(), // alive → captured
    ], FLAIRS, NOW, DELAY_S, TEXT_MIN)
    expect(rows.map((r) => r.id)).toEqual(['abc123'])
    expect(removed).toBe(3)
  })
})

describe('isRemovedPost', () => {
  it('flags removal markers and nothing else', () => {
    expect(isRemovedPost(rawPost({ selftext: '[removed]' }))).toBe(true)
    expect(isRemovedPost(rawPost({ selftext: '[deleted]' }))).toBe(true)
    expect(isRemovedPost(rawPost({ removed_by_category: 'automod_filtered' }))).toBe(true)
    expect(isRemovedPost(rawPost())).toBe(false)
    expect(isRemovedPost(rawPost({ selftext: 'I removed my hedge' }))).toBe(false)
    expect(isRemovedPost(rawPost({ removed_by_category: null }))).toBe(false)
    expect(isRemovedPost(rawPost({ removed_by_category: '' }))).toBe(false)
  })
})

describe('initialMediaStatus (capture-time shape classification, product §3)', () => {
  it('direct i.redd.it image → pending', () => {
    expect(initialMediaStatus(rawPost())).toBe('pending')
  })
  it('gallery → pending (regardless of whether the archive included its media_metadata)', () => {
    expect(initialMediaStatus(rawPost({
      url: 'https://www.reddit.com/gallery/abc123', is_gallery: true, media_metadata: null,
    }))).toBe('pending')
  })
  it('inline self-post images (media_metadata present) → pending, not silently text-only', () => {
    expect(initialMediaStatus(rawPost({
      url: 'https://www.reddit.com/r/wallstreetbets/comments/abc123/x/', is_gallery: false,
      media_metadata: { q1w2e3: { status: 'valid', e: 'Image', m: 'image/png' } },
    }))).toBe('pending')
  })
  it('text-only / external-link posts → none', () => {
    expect(initialMediaStatus(rawPost({ url: '', media_metadata: null }))).toBe('none')
    expect(initialMediaStatus(rawPost({ url: 'https://example.com/article', media_metadata: null }))).toBe('none')
    expect(initialMediaStatus(rawPost({ url: 'https://v.redd.it/abc123', media_metadata: null }))).toBe('none') // video: v1 text-only
    expect(initialMediaStatus(rawPost({ url: null, media_metadata: {} }))).toBe('none') // empty metadata
  })
})
