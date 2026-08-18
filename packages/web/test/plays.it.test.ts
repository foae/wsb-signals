/**
 * Web plays read-path integration test (P1) on real Postgres. Pins the bare-list contract:
 * newest-first order, thumbnail = first media item, media/text-only tolerance, and that the assembled
 * payload passes the response schema the API validates against.
 */
import { plays } from '@wsb/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { PlaysResponseSchema, readPlays } from '../server/utils/plays'
import { startPg, type PgHarness } from './helpers/pg'

let pg: PgHarness
beforeAll(async () => { pg = await startPg() }, 120_000)
afterAll(async () => { await pg?.stop() })
beforeEach(async () => { await pg.reset() })

const T = 1_755_500_000

describe('readPlays — the bare P1 list', () => {
  it('returns [] with no rows and validates against the schema', async () => {
    const rows = await readPlays(pg.db)
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

    const rows = await readPlays(pg.db)
    expect(rows.map((r) => r.id)).toEqual(['new1', 'old1'])
    expect(rows[0]).toMatchObject({ thumb: null, imageCount: 0, mediaStatus: 'none', flair: 'YOLO' })
    expect(rows[1]).toMatchObject({ thumb: 'old1/0.jpg', imageCount: 2, mediaStatus: 'archived' })
    expect(() => PlaysResponseSchema.parse({ plays: rows })).not.toThrow()
  })
})
