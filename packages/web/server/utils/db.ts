/**
 * Read-only Postgres access for the web (slice 8). The web is a READ-ONLY reader of the worker's board:
 *
 *  - The connection string (`NUXT_DATABASE_URL`) is a **read-only Postgres role** the worker provisions on
 *    boot (`packages/worker/src/ensure-read-role.ts`). Even if a query tried to write, the role rejects it.
 *  - The web NEVER migrates — the worker owns DDL/migrations (v2-plan §1, porting-spec §6).
 *  - The `pg.Pool` + Drizzle client is a **module-level singleton bound to `globalThis`** so Nitro's dev
 *    HMR reuses ONE pool across reloads instead of leaking a new one each time (and the prod single-process
 *    server keeps one pool for its lifetime). `server/plugins/close-db.ts` ends it on Nitro shutdown.
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

declare global {
  var __wsbPool: Pool | undefined
  var __wsbDb: NodePgDatabase | undefined
}

/** The shared read-only Drizzle handle (lazy singleton). */
export function useDb(): NodePgDatabase {
  if (globalThis.__wsbDb) return globalThis.__wsbDb
  const url = useRuntimeConfig().databaseUrl
  if (!url) throw new Error('NUXT_DATABASE_URL is required (the read-only Postgres connection string)')
  const pool = new Pool({ connectionString: url, max: 5, keepAlive: true })
  globalThis.__wsbPool = pool
  globalThis.__wsbDb = drizzle(pool)
  return globalThis.__wsbDb
}

/** End the pool (Nitro `close` hook). Safe to call when nothing was opened. */
export async function closeDb(): Promise<void> {
  await globalThis.__wsbPool?.end()
  globalThis.__wsbPool = undefined
  globalThis.__wsbDb = undefined
}
