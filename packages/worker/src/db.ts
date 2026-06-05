/**
 * Persistence layer — TS port of the frozen v0.0.1 `wsb_signals/db.py` upserts, on Postgres/Drizzle.
 *
 * Parity points the port preserves (v2-porting-spec.md §6):
 *  - **per-table ON CONFLICT semantics differ** and are NOT interchangeable — posts/comments keep
 *    first-seen and only refresh engagement; mentions are immutable (DO NOTHING); features DO UPDATE all;
 *  - **≤1000-row chunking** so a batch never blows the Postgres 65535 bind-parameter cap;
 *  - **atomic per-cycle publish** — a window's features + its `cycle_runs` marker commit in ONE
 *    transaction, so a reader sees a whole cycle or none (the shadow-diff / future web read the latest
 *    complete window). This replaces the v0.0.1 DuckDB-lock + JSON-snapshot workaround entirely.
 */
import { desc, getTableColumns, sql, type SQL } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import type { PgTable } from 'drizzle-orm/pg-core'
import { Pool } from 'pg'

import {
  analyticalFeatures, cycleRuns, empiricalFeatures, marketMovers, mentions, rawComments, rawPosts,
  tickerNames,
  type AnalyticalFeatureInsert, type MarketMoverInsert, type MentionInsert, type RawCommentInsert,
  type RawPostInsert, type TickerNameInsert,
} from '@wsb/shared'
import { migrationsFolder } from '@wsb/shared/migrations'

import type { EmpiricalFeature } from './aggregate'

export type Db = NodePgDatabase
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Executor = Db | Tx

export interface DbHandle {
  db: Db
  pool: Pool
  close: () => Promise<void>
}

/** Open a writer connection (the worker is the single writer; the web gets a read-only role). */
export function createDb(connectionString: string): DbHandle {
  const pool = new Pool({ connectionString })
  const db = drizzle(pool)
  return { db, pool, close: () => pool.end() }
}

/** Run pending migrations on boot — the worker owns DDL; the web never migrates (porting-spec §6). */
export async function migrateToLatest(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder })
}

// --- chunking + ON CONFLICT helpers ---------------------------------------------------------------

const PG_MAX_PARAMS = 65535

/** Split rows so one INSERT never exceeds the bind-parameter cap; ≤1000 rows/statement (porting-spec §6). */
function chunkForCols<T>(rows: readonly T[], colsPerRow: number): T[][] {
  const max = Math.max(1, Math.min(1000, Math.floor(PG_MAX_PARAMS / Math.max(1, colsPerRow))))
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += max) out.push(rows.slice(i, i + max))
  return out
}

/** Build a DO UPDATE `set` that copies the named columns from the conflicting row (`excluded.<col>`). */
function excludedSet(table: PgTable, props: readonly string[]): Record<string, SQL> {
  const cols = getTableColumns(table) as Record<string, { name: string }>
  const set: Record<string, SQL> = {}
  for (const p of props) set[p] = sql`excluded.${sql.identifier(cols[p]!.name)}`
  return set
}

// --- upserts (one per table, exact v0.0.1 ON CONFLICT semantics) -----------------------------------

/** Live re-fetch refreshes engagement only; title/author/body are kept first-seen. */
export async function upsertPosts(ex: Executor, rows: readonly RawPostInsert[]): Promise<void> {
  for (const chunk of chunkForCols(rows, 10)) {
    await ex.insert(rawPosts).values(chunk).onConflictDoUpdate({
      target: rawPosts.id, set: excludedSet(rawPosts, ['score', 'numComments', 'retrievedOn']),
    })
  }
}

export async function upsertComments(ex: Executor, rows: readonly RawCommentInsert[]): Promise<void> {
  for (const chunk of chunkForCols(rows, 9)) {
    await ex.insert(rawComments).values(chunk).onConflictDoUpdate({
      target: rawComments.id, set: excludedSet(rawComments, ['score', 'retrievedOn']),
    })
  }
}

/** Mention identity (ticker, thing_id) is immutable — keep first-seen (DO NOTHING). */
export async function upsertMentions(ex: Executor, rows: readonly MentionInsert[]): Promise<void> {
  for (const chunk of chunkForCols(rows, 7)) {
    await ex.insert(mentions).values(chunk).onConflictDoNothing({
      target: [mentions.ticker, mentions.thingId],
    })
  }
}

const EMP_UPDATE = [
  'mentions', 'authors', 'sov', 'velocity', 'accel', 'z', 'netDir', 'ddCount', 'flairCounts',
  'baselineStatus', 'hE',
] as const

export async function upsertEmpiricalFeatures(ex: Executor, rows: readonly EmpiricalFeature[]): Promise<void> {
  for (const chunk of chunkForCols(rows, 13)) {
    await ex.insert(empiricalFeatures).values(chunk).onConflictDoUpdate({
      target: [empiricalFeatures.ticker, empiricalFeatures.windowStart],
      set: excludedSet(empiricalFeatures, EMP_UPDATE),
    })
  }
}

const ANALYTICAL_UPDATE = ['ret', 'rvol', 'rvolConf', 'pcr', 'ivRank', 'breadth', 'hM'] as const

export async function upsertAnalyticalFeatures(ex: Executor, rows: readonly AnalyticalFeatureInsert[]): Promise<void> {
  for (const chunk of chunkForCols(rows, 9)) {
    await ex.insert(analyticalFeatures).values(chunk).onConflictDoUpdate({
      target: [analyticalFeatures.ticker, analyticalFeatures.windowStart],
      set: excludedSet(analyticalFeatures, ANALYTICAL_UPDATE),
    })
  }
}

export async function upsertMovers(ex: Executor, rows: readonly MarketMoverInsert[]): Promise<void> {
  for (const chunk of chunkForCols(rows, 7)) {
    await ex.insert(marketMovers).values(chunk).onConflictDoUpdate({
      target: [marketMovers.ts, marketMovers.kind, marketMovers.rank],
      set: excludedSet(marketMovers, ['symbol', 'price', 'percentChange', 'volume']),
    })
  }
}

export async function upsertTickerNames(ex: Executor, rows: readonly TickerNameInsert[]): Promise<void> {
  for (const chunk of chunkForCols(rows, 2)) {
    await ex.insert(tickerNames).values(chunk).onConflictDoUpdate({
      target: tickerNames.symbol, set: excludedSet(tickerNames, ['name']),
    })
  }
}

// --- atomic per-cycle publish ----------------------------------------------------------------------

export interface CycleMeta {
  windowStart: number
  generatedAt: number
  totalMentions: number
  quiet: boolean
  capped: boolean
}

export interface CyclePayload {
  meta: CycleMeta
  features: readonly EmpiricalFeature[]
  analytical?: readonly AnalyticalFeatureInsert[] // slice 5
  movers?: readonly MarketMoverInsert[] // slice 5
}

/**
 * Publish one cycle atomically: the window's features (+ optional market overlay) and the `cycle_runs`
 * marker commit in a single transaction. Until it commits no reader sees any of it; the marker's
 * presence == this window is complete and durable.
 */
export async function publishCycle(db: Db, payload: CyclePayload): Promise<void> {
  const { meta } = payload
  await db.transaction(async (tx) => {
    await upsertEmpiricalFeatures(tx, payload.features)
    if (payload.analytical?.length) await upsertAnalyticalFeatures(tx, payload.analytical)
    if (payload.movers?.length) await upsertMovers(tx, payload.movers)
    await tx.insert(cycleRuns).values({
      windowStart: meta.windowStart,
      generatedAt: meta.generatedAt,
      totalMentions: meta.totalMentions,
      quiet: meta.quiet,
      capped: meta.capped,
      status: 'complete',
    }).onConflictDoUpdate({
      target: cycleRuns.windowStart,
      set: excludedSet(cycleRuns, ['generatedAt', 'totalMentions', 'quiet', 'capped', 'status']),
    })
  })
}

/** The read contract: the latest COMPLETE window (the shadow-diff now, the web later read only this). */
export async function latestCompleteWindow(db: Db): Promise<number | null> {
  const rows = await db.select({ ws: cycleRuns.windowStart }).from(cycleRuns)
    .orderBy(desc(cycleRuns.windowStart)).limit(1)
  return rows[0]?.ws ?? null
}
