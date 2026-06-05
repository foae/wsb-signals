import { eq } from 'drizzle-orm'
import { mentions } from '@wsb/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startPg, type PgHarness } from './helpers/pg'

// Wiring proof: the shared Drizzle schema applies (via the real migrator) to a real Postgres and a row
// round-trips. The broader persistence semantics live in persistence.it.test.ts.
let pg: PgHarness

beforeAll(async () => { pg = await startPg() })
afterAll(async () => { await pg?.stop() })

describe('shared schema on Postgres (testcontainers)', () => {
  it('round-trips a mentions row', async () => {
    await pg.db.insert(mentions).values({
      ticker: 'NVDA', thingId: 't3_abc', thingType: 'post', createdUtc: 1_700_000_000,
      author: 'u1', flair: 'DD', direction: 'bull',
    })
    const rows = await pg.db.select().from(mentions).where(eq(mentions.ticker, 'NVDA'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.thingId).toBe('t3_abc')
    expect(rows[0]?.createdUtc).toBe(1_700_000_000) // BIGINT mode:'number' — no precision/string drift
  })
})
