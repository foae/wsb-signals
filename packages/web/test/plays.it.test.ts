/**
 * Web plays read-path integration tests on real Postgres. Pins the list contract (newest-first order,
 * thumbnail = first media item, media/text-only tolerance, P3's denormalized board fields on the card,
 * P4's server-side filters/sorts + the hide-low-confidence default) and the detail contract (children
 * read BY the current-run pointers; a dangling pointer degrades the section to null; lenient jsonb
 * parse), plus that assembled payloads pass the API response schemas.
 */
import { playExtractions, playInterpretations, plays } from '@wsb/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  PlayDetailSchema, PlaysQuerySchema, PlaysResponseSchema, readPlayDetail, readPlays,
  type PlaysQuery,
} from '../server/utils/plays'
import { startPg, type PgHarness } from './helpers/pg'

let pg: PgHarness
beforeAll(async () => { pg = await startPg() }, 120_000)
afterAll(async () => { await pg?.stop() })
beforeEach(async () => { await pg.reset() })

const T = 1_755_500_000

/** A parsed query with defaults (`all: false`, `sort: 'newest'`) + overrides. */
const Q = (over: Partial<PlaysQuery> = {}): PlaysQuery => ({ ...PlaysQuerySchema.parse({}), ...over })

describe('readPlays — the bare P1 list', () => {
  it('returns [] with no rows and validates against the schema', async () => {
    const rows = await readPlays(pg.db, Q())
    expect(rows).toEqual([])
    expect(() => PlaysResponseSchema.parse({ plays: rows })).not.toThrow()
  })

  it('lists newest first with thumbnails from the first media item; text-only rows carry null', async () => {
    await pg.db.insert(plays).values([
      {
        id: 'old1', createdUtc: T - 3600, capturedAt: T - 3500, author: 'a', flair: 'Gain',
        title: 'older archived play', permalink: '/r/wsb/comments/old1/x/', status: 'media_ready',
        mediaStatus: 'archived', isGallery: true, attempts: 0,
        media: [
          { order: 0, path: 'old1/0.jpg', ext: 'jpg', bytes: 10, sha256: 'aa', sourceUrl: 'u0' },
          { order: 1, path: 'old1/1.png', ext: 'png', bytes: 20, sha256: 'bb', sourceUrl: 'u1' },
        ],
      },
      {
        id: 'new1', createdUtc: T, capturedAt: T + 100, author: 'b', flair: 'YOLO',
        title: 'newer text-only play', permalink: '/r/wsb/comments/new1/x/', status: 'captured',
        mediaStatus: 'none', isGallery: false, attempts: 0, media: null,
      },
    ])

    const rows = await readPlays(pg.db, Q())
    expect(rows.map((r) => r.id)).toEqual(['new1', 'old1'])
    expect(rows[0]).toMatchObject({ thumb: null, imageCount: 0, mediaStatus: 'none', flair: 'YOLO' })
    expect(rows[1]).toMatchObject({ thumb: 'old1/0.jpg', imageCount: 2, mediaStatus: 'archived' })
    // Unpublished rows carry null board fields — the card falls back to queue status.
    expect(rows[0]).toMatchObject({ primaryTicker: null, category: null, pnlAbs: null, tldr: null })
    expect(() => PlaysResponseSchema.parse({ plays: rows })).not.toThrow()
  })

  it('excludes discarded tombstones (removed posts / zero-position extractions) from the list', async () => {
    await pg.db.insert(plays).values([
      { id: 'live1', createdUtc: T, capturedAt: T, status: 'published', mediaStatus: 'none', attempts: 0 },
      { id: 'dead1', createdUtc: T + 10, capturedAt: T, status: 'discarded', mediaStatus: 'none', attempts: 0 },
    ])
    const rows = await readPlays(pg.db, Q())
    expect(rows.map((r) => r.id)).toEqual(['live1'])
  })

  it('carries the P3 denormalized board fields on published plays', async () => {
    await pg.db.insert(plays).values({
      id: 'pub1', createdUtc: T, capturedAt: T, publishedAt: T + 900, author: 'c', flair: 'Gain',
      title: 'published play', permalink: '/r/wsb/comments/pub1/x/', status: 'published',
      mediaStatus: 'archived', attempts: 0,
      media: [{ order: 0, path: 'pub1/0.jpg', ext: 'jpg', bytes: 10, sha256: 'cc', sourceUrl: 'u' }],
      primaryTicker: 'NVDA', category: 'high-risk-high-reward', tags: ['0dte'], confidence: 0.8,
      pnlAbs: 12_345.67, pnlPct: 210.5, realized: true, tldr: 'one line', summary: 'longer text',
    })

    const rows = await readPlays(pg.db, Q())
    expect(rows[0]).toMatchObject({
      id: 'pub1', publishedAt: T + 900, primaryTicker: 'NVDA', category: 'high-risk-high-reward',
      confidence: 0.8, pnlAbs: 12_345.67, pnlPct: 210.5, realized: true, tldr: 'one line',
    })
    expect(() => PlaysResponseSchema.parse({ plays: rows })).not.toThrow()
  })
})

describe('readPlays — P4 filters & sorts', () => {
  /** Fixture set spanning the filter axes; `pending1` has no board fields yet (in-pipeline). */
  const seed = () => pg.db.insert(plays).values([
    {
      id: 'gain1', createdUtc: T, capturedAt: T, status: 'published', mediaStatus: 'none', attempts: 0,
      primaryTicker: 'NVDA', category: 'high-risk-high-reward', tags: ['0dte', 'options'],
      confidence: 0.8, pnlAbs: 5000, pnlPct: 100, realized: true,
    },
    {
      id: 'loss1', createdUtc: T - 100, capturedAt: T, status: 'published', mediaStatus: 'none', attempts: 0,
      primaryTicker: 'MRNA', category: 'herd-following', tags: ['options'],
      confidence: 0.7, pnlAbs: -12_000, pnlPct: -60, realized: true,
    },
    {
      id: 'weak1', createdUtc: T - 200, capturedAt: T, status: 'published', mediaStatus: 'none', attempts: 0,
      primaryTicker: 'GME', category: 'dumb-luck', tags: [], confidence: 0.5, pnlAbs: 100, realized: true,
    },
    {
      id: 'uncl1', createdUtc: T - 300, capturedAt: T, status: 'published', mediaStatus: 'none', attempts: 0,
      primaryTicker: null, category: 'unclassifiable', tags: [], confidence: 0.9, pnlAbs: null,
    },
    { id: 'pending1', createdUtc: T - 400, capturedAt: T, status: 'extracted', mediaStatus: 'none', attempts: 0 },
    {
      id: 'old2', createdUtc: T - 10 * 86_400, capturedAt: T, status: 'published', mediaStatus: 'none',
      attempts: 0, primaryTicker: 'NVDA', category: 'bag-holding', tags: [], confidence: 0.9,
      pnlAbs: -300, realized: false,
    },
  ])

  it('default view hides unclassifiable and low-confidence rows but keeps in-pipeline ones; all=1 reveals', async () => {
    await seed()
    const byDefault = await readPlays(pg.db, Q())
    expect(byDefault.map((r) => r.id)).toEqual(['gain1', 'loss1', 'pending1', 'old2'])
    const revealed = await readPlays(pg.db, Q({ all: true }))
    expect(revealed.map((r) => r.id)).toEqual(['gain1', 'loss1', 'weak1', 'uncl1', 'pending1', 'old2'])
  })

  it('filters by category, ticker, tag containment, P&L sign, confidence floor, and since', async () => {
    await seed()
    expect((await readPlays(pg.db, Q({ category: 'herd-following' }))).map((r) => r.id)).toEqual(['loss1'])
    expect((await readPlays(pg.db, Q({ ticker: 'NVDA' }))).map((r) => r.id)).toEqual(['gain1', 'old2'])
    expect((await readPlays(pg.db, Q({ tag: 'options' }))).map((r) => r.id)).toEqual(['gain1', 'loss1'])
    // sign is on the play's posted P&L; rows without one (pending/unclassifiable) drop out.
    expect((await readPlays(pg.db, Q({ sign: 'gain' }))).map((r) => r.id)).toEqual(['gain1'])
    expect((await readPlays(pg.db, Q({ sign: 'loss' }))).map((r) => r.id)).toEqual(['loss1', 'old2'])
    expect((await readPlays(pg.db, Q({ minConf: 0.8 }))).map((r) => r.id)).toEqual(['gain1', 'old2'])
    expect((await readPlays(pg.db, Q({ since: T - 86_400 }))).map((r) => r.id))
      .toEqual(['gain1', 'loss1', 'pending1'])
  })

  it('sort=pnl orders by |posted P&L| desc with null-P&L rows last', async () => {
    await seed()
    const rows = await readPlays(pg.db, Q({ sort: 'pnl' }))
    expect(rows.map((r) => r.id)).toEqual(['loss1', 'gain1', 'old2', 'pending1'])
  })

  it('the query schema uppercases tickers, defaults, and rejects junk', () => {
    expect(PlaysQuerySchema.parse({ ticker: 'nvda', all: '1' })).toMatchObject({
      ticker: 'NVDA', all: true, sort: 'newest',
    })
    expect(PlaysQuerySchema.safeParse({ sort: 'sideways' }).success).toBe(false)
    expect(PlaysQuerySchema.safeParse({ minConf: '2' }).success).toBe(false)
  })
})

describe('readPlayDetail — the /plays/:id read', () => {
  it('returns null for an unknown id', async () => {
    expect(await readPlayDetail(pg.db, 'nope')).toBeNull()
  })

  it('serves the current extraction/interpretation runs by pointer and validates', async () => {
    const extAt = (T + 100) * 1000
    const intAt = (T + 200) * 1000
    await pg.db.insert(plays).values({
      id: 'pub1', createdUtc: T, capturedAt: T, publishedAt: T + 900, author: 'c', flair: 'Gain',
      title: 'published play', selftext: 'body', permalink: '/r/wsb/comments/pub1/x/',
      status: 'published', mediaStatus: 'archived', attempts: 0,
      media: [
        { order: 0, path: 'pub1/0.jpg', ext: 'jpg', bytes: 10, sha256: 'cc', sourceUrl: 'u0' },
        { order: 1, path: 'pub1/1.jpg', ext: 'jpg', bytes: 11, sha256: 'dd', sourceUrl: 'u1' },
      ],
      currentExtractionAt: extAt, currentInterpretationAt: intAt,
      primaryTicker: 'NVDA', category: 'dumb-luck', tags: ['0dte'], confidence: 0.8,
      pnlAbs: 100, pnlPct: 50, realized: true, tldr: 'one line', summary: 'longer text',
      extractorVersion: 'ext-v4', interpreterVersion: 'int-v1', taxonomyVersion: 'taxonomy-v1',
    })
    await pg.db.insert(playExtractions).values([
      // A STALE run the pointer must not pick up.
      { playId: 'pub1', runAt: extAt - 1000, model: 'old', output: { positions: [] } },
      {
        playId: 'pub1', runAt: extAt, model: 'm1', promptVersion: 'p1',
        output: {
          screenshot_kind: 'single_position', broker: 'Robinhood', notes: null,
          direction: 'bullish', confidence: 0.8, model_confidence: 0.9,
          positions: [{
            position_id: 'nvda:call:long:250:2026-09-18', ticker: 'NVDA', instrument: 'call',
            side: 'long', quantity: 10, avg_price: 5.5, strike: 250, expiry: '2026-09-18',
            cost_basis: 5500, current_value: 11000, pnl_abs: 5500, pnl_pct: 100, realized: true,
            opened_at: '2026-08-10', currency: null, confidence: 0.9, field_confidence: null,
            ticker_outcome: 'validated', arithmetic_ok: true,
          }],
        },
      },
    ])
    await pg.db.insert(playInterpretations).values({
      playId: 'pub1', runAt: intAt, model: 'm2', promptVersion: 'p2',
      output: {
        thesis: 't', outcome: 'o', context: null, category: 'dumb-luck', tags: ['0dte'],
        summary: 'longer text', tldr: 'one line', confidence: 0.7, herd_allowed: false,
      },
      evidence: {
        ticker: 'NVDA', direction: 'bullish', anchor_utc: T - 86_400, anchor_basis: 'opened_at',
        post_utc: T,
        radar: { window_start: T - 90_000, heat: { rank: 3, sov: 0.12, h_e: 0.5, mentions: 40, authors: 25 }, mentions_24h: 40, authors_24h: 25, mentions_72h: 90, authors_72h: 50, note: null },
        herd: { direction: 'bull', distinct_authors: 2, threshold: 5, lookback_hours: 24, eligible: false },
        market: { as_of: T, day_ret: 0.031, five_day_ret: -0.02, rvol: 1.4, rvol_conf: 'low', movers: ['gainer'], note: null },
        note: null,
      },
    })

    const detail = await readPlayDetail(pg.db, 'pub1')
    expect(detail).not.toBeNull()
    expect(detail!.play).toMatchObject({
      id: 'pub1', selftext: 'body', tags: ['0dte'], summary: 'longer text',
      images: [{ path: 'pub1/0.jpg', order: 0 }, { path: 'pub1/1.jpg', order: 1 }],
    })
    expect(detail!.extraction).toMatchObject({ model: 'm1', runAt: extAt })
    expect(detail!.extraction!.output!.positions[0]).toMatchObject({ ticker: 'NVDA', strike: 250 })
    expect(detail!.interpretation).toMatchObject({ model: 'm2', runAt: intAt })
    expect(detail!.interpretation!.output).toMatchObject({ category: 'dumb-luck', tldr: 'one line' })
    expect(detail!.interpretation!.evidence).toMatchObject({
      anchor_basis: 'opened_at',
      radar: expect.objectContaining({ mentions_24h: 40 }),
      herd: expect.objectContaining({ eligible: false }),
    })
    expect(() => PlayDetailSchema.parse(detail)).not.toThrow()
  })

  it('degrades a dangling current-run pointer and drifted jsonb to null sections, not a throw', async () => {
    await pg.db.insert(plays).values({
      id: 'part1', createdUtc: T, capturedAt: T, status: 'extracted', mediaStatus: 'none',
      attempts: 0, currentExtractionAt: (T + 100) * 1000, currentInterpretationAt: (T + 200) * 1000,
    })
    // Extraction child exists but its output is shape-drifted junk; interpretation child is MISSING
    // (pointer dangles — the partial-reprocess crash case).
    await pg.db.insert(playExtractions).values({
      playId: 'part1', runAt: (T + 100) * 1000, model: 'm1', output: { positions: 'not-an-array', broker: 7 },
    })

    const detail = await readPlayDetail(pg.db, 'part1')
    expect(detail).not.toBeNull()
    expect(detail!.extraction!.output).toMatchObject({ positions: [], broker: null })
    expect(detail!.interpretation).toBeNull()
    expect(() => PlayDetailSchema.parse(detail)).not.toThrow()
  })
})
