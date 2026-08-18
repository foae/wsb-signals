import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'

import { createDb, migrateToLatest, type DbHandle } from '../../src/db'

export interface PgHarness extends DbHandle {
  container: StartedPostgreSqlContainer
  /** TRUNCATE every table so each test starts clean (one container is shared across a suite). */
  reset: () => Promise<void>
  stop: () => Promise<void>
}

const TABLES = [
  'raw_posts', 'raw_comments', 'mentions', 'empirical_features', 'analytical_features',
  'market_bars', 'options_snapshot', 'signals', 'baselines', 'market_movers', 'ticker_names',
  'cycle_runs',
  'plays', 'play_extractions', 'play_interpretations', 'play_marks', 'play_links',
]

/**
 * Start a throwaway Postgres, open the worker's writer connection, and run the REAL migrations
 * (drizzle-orm migrator over packages/shared/drizzle) — exactly what the worker does on boot. Shared by
 * every persistence/parity-on-PG integration test.
 */
export async function startPg(): Promise<PgHarness> {
  const container = await new PostgreSqlContainer('postgres:18-alpine').start()
  const handle: DbHandle = createDb(container.getConnectionUri())
  await migrateToLatest(handle.db)
  return {
    ...handle,
    container,
    reset: async () => { await handle.pool.query(`TRUNCATE ${TABLES.join(', ')} CASCADE`) },
    stop: async () => { await handle.close(); await container.stop() },
  }
}
