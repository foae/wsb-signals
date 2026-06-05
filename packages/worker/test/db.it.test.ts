import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { eq } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { mentions } from '@wsb/shared'

// Integration wiring proof (slice 0): the shared Drizzle schema applies to a real Postgres and a row
// round-trips through drizzle-orm/node-postgres. This is the testcontainers harness every later
// persistence/parity-on-PG test (slice 3+) builds on.
//
// The migration SQL is the one drizzle-kit generates from packages/shared/src/schema.ts — applying it
// here (rather than re-deriving DDL) keeps this test honest about what the worker will actually run.
const MIGRATION = fileURLToPath(new URL('../../shared/drizzle/0000_init.sql', import.meta.url))

describe('shared schema on Postgres (testcontainers)', () => {
  let container: StartedPostgreSqlContainer
  let pool: Pool
  let db: NodePgDatabase

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine').start()
    pool = new Pool({ connectionString: container.getConnectionUri() })
    // drizzle-kit separates statements with `--> statement-breakpoint`; split so each runs cleanly.
    const sql = readFileSync(MIGRATION, 'utf8')
    for (const stmt of sql.split('--> statement-breakpoint')) {
      if (stmt.trim()) await pool.query(stmt)
    }
    db = drizzle(pool)
  })

  afterAll(async () => {
    await pool?.end()
    await container?.stop()
  })

  it('round-trips a mentions row', async () => {
    await db.insert(mentions).values({
      ticker: 'NVDA',
      thingId: 't3_abc',
      thingType: 'post',
      createdUtc: 1_700_000_000,
      author: 'u1',
      flair: 'DD',
      direction: 'bull',
    })
    const rows = await db.select().from(mentions).where(eq(mentions.ticker, 'NVDA'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.thingId).toBe('t3_abc')
    expect(rows[0]?.createdUtc).toBe(1_700_000_000) // BIGINT mode:'number' — no precision loss / string drift
  })
})
