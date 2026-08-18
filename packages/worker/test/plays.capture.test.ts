import { describe, expect, it } from 'vitest'

import type { RawThing } from '../src/ingest'
import { initialMediaStatus, playRowsFromRaw } from '../src/plays/capture'

// P1 capture mapping (plays-plan §3): flair gate, raw→row mapping, and the capture-time media-shape
// classification. The DB semantics (ON CONFLICT DO NOTHING, never-backwards) live in plays.it.test.ts.

const FLAIRS = new Set(['Gain', 'Loss', 'YOLO', 'Verified Trade'])
const NOW = 1_755_500_000

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
    const rows = playRowsFromRaw([
      rawPost(),
      rawPost({ id: 'dd1', link_flair_text: 'DD' }), // wrong flair
      rawPost({ id: 'nf1', link_flair_text: null }), // no flair
      rawPost({ id: 'nf2', link_flair_text: undefined }),
    ], FLAIRS, NOW)

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
    expect(playRowsFromRaw([rawPost({ id: undefined }), rawPost({ id: 42 }), rawPost({ id: '' })], FLAIRS, NOW))
      .toEqual([])
  })

  it('drops path-capable ids — the id becomes a filesystem/URL segment (media dir, /api/media)', () => {
    const hostile = ['../pwn', 'a/b', 'a.b', 'a b', '.', '..', 'x'.repeat(33)]
    expect(playRowsFromRaw(hostile.map((id) => rawPost({ id })), FLAIRS, NOW)).toEqual([])
  })

  it('tolerates junk-typed fields (nulls, not throws)', () => {
    const rows = playRowsFromRaw(
      [rawPost({ author: 42, title: null, created_utc: 'soon', score: 'many', url: 7, permalink: {} })],
      FLAIRS, NOW,
    )
    expect(rows[0]).toMatchObject({
      id: 'abc123', author: null, title: null, createdUtc: null, score: null, url: null, permalink: null,
    })
  })
})

describe('initialMediaStatus (capture-time shape classification, product §3)', () => {
  it('direct i.redd.it image → pending', () => {
    expect(initialMediaStatus(rawPost())).toBe('pending')
  })
  it('gallery → pending (even though Arctic-Shift archives its media_metadata as null)', () => {
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
