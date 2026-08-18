/**
 * Throwaway Postgres for the web's read-path integration test. Starts the SAME image the deploy uses
 * (postgres:18-alpine), runs the REAL worker migrations (drizzle-orm migrator over the committed
 * `@wsb/shared` drizzle folder), and hands back a Drizzle handle so the test can seed cycles and call
 * `readBoard(db)` exactly as the API does. Standalone (no worker-package import) — the web reads the DB,
 * it doesn't depend on worker internals.
 */
import { migrationsFolder } from '@wsb/shared/migrations'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'

export interface PgHarness {
  db: NodePgDatabase
  pool: Pool
  container: StartedPostgreSqlContainer
  reset: () => Promise<void>
  stop: () => Promise<void>
}

const TABLES = [
  'raw_posts', 'raw_comments', 'mentions', 'empirical_features', 'analytical_features',
  'market_bars', 'options_snapshot', 'signals', 'baselines', 'market_movers', 'ticker_names',
  'cycle_runs',
  'plays', 'play_extractions', 'play_interpretations', 'play_marks', 'play_links',
]

export async function startPg(): Promise<PgHarness> {
  const container = await new PostgreSqlContainer('postgres:18-alpine').start()
  const pool = new Pool({ connectionString: container.getConnectionUri() })
  const db = drizzle(pool)
  await migrate(db, { migrationsFolder })
  return {
    db,
    pool,
    container,
    reset: async () => { await pool.query(`TRUNCATE ${TABLES.join(', ')} CASCADE`) },
    stop: async () => { await pool.end(); await container.stop() },
  }
}
