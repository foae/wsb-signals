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
import { and, asc, desc, eq, getTableColumns, gte, inArray, lt, sql, type SQL } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import type { PgTable } from 'drizzle-orm/pg-core'
import { Pool, type PoolClient } from 'pg'

import {
  analyticalFeatures, cycleRuns, empiricalFeatures, marketMovers, mentions, rawComments, rawPosts,
  signals, tickerNames,
  type AnalyticalFeatureInsert, type MarketMoverInsert, type MentionInsert, type RawCommentInsert,
  type RawPostInsert, type SignalInsert, type TickerNameInsert,
} from '@wsb/shared'
import { migrationsFolder } from '@wsb/shared/migrations'

import { compareBoard, type EmpiricalFeature, type HistoryRow, type MentionRow, type PriorFeatures } from './aggregate'
import type { SeriesPoint } from './analytics'

export type Db = NodePgDatabase
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type Executor = Db | Tx

export interface DbHandle {
  db: Db
  pool: Pool
  close: () => Promise<void>
}

/** Open a writer connection (the worker is the single writer; the web gets a read-only role).
 *  `keepAlive` keeps the long-lived advisory-lock connection from being reaped by an idle TCP timeout. */
export function createDb(connectionString: string): DbHandle {
  const pool = new Pool({ connectionString, keepAlive: true })
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

const SIGNALS_UPDATE = ['hE', 'hM', 'divergence', 'quadrant', 'rank', 'rankDelta', 'leadLagHrs'] as const

/** Per-(ticker, window) Attention×Action signals (slice 7). Plain upsert — like `empirical_features`,
 *  the grain is the board ticker and the within-window board is monotonic (mentions only accumulate), so
 *  there is no shrunk-set staleness to delete-then-insert around (unlike the top-N-gated analytical set). */
export async function upsertSignals(ex: Executor, rows: readonly SignalInsert[]): Promise<void> {
  for (const chunk of chunkForCols(rows, 9)) {
    await ex.insert(signals).values(chunk).onConflictDoUpdate({
      target: [signals.ticker, signals.windowStart],
      set: excludedSet(signals, SIGNALS_UPDATE),
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
  newestUtc: number | null // freshest source item this cycle — persisted for the staleness banner (§7)
}

export interface CyclePayload {
  meta: CycleMeta
  features: readonly EmpiricalFeature[]
  analytical?: readonly AnalyticalFeatureInsert[] // slice 5
  movers?: readonly MarketMoverInsert[] // slice 5
  signals?: readonly SignalInsert[] // slice 7 — divergence / quadrant / lead-lag
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
    // Exact-cycle analytical set: when an overlay IS supplied, it REPLACES this window's analytical rows
    // (delete-then-insert) so a shrunk top-N can't leave stale rows behind. When it's omitted (undefined —
    // e.g. a best-effort market fetch failed), leave the prior overlay untouched (never-kill, architecture §5).
    if (payload.analytical !== undefined) {
      await tx.delete(analyticalFeatures).where(eq(analyticalFeatures.windowStart, meta.windowStart))
      if (payload.analytical.length) await upsertAnalyticalFeatures(tx, payload.analytical)
    }
    if (payload.movers?.length) await upsertMovers(tx, payload.movers)
    // Signals share the empirical grain (one row per board ticker for THIS window_start) — a plain upsert
    // in the same atomic transaction, so a reader sees the window's features + signals together or not at all.
    if (payload.signals?.length) await upsertSignals(tx, payload.signals)
    await tx.insert(cycleRuns).values({
      windowStart: meta.windowStart,
      generatedAt: meta.generatedAt,
      totalMentions: meta.totalMentions,
      quiet: meta.quiet,
      capped: meta.capped,
      newestUtc: meta.newestUtc,
      status: 'complete',
    }).onConflictDoUpdate({
      target: cycleRuns.windowStart,
      set: excludedSet(cycleRuns, ['generatedAt', 'totalMentions', 'quiet', 'capped', 'newestUtc', 'status']),
    })
  })
}

/** The read contract: the latest COMPLETE window (the shadow-diff now, the web later read only this).
 *  Filters on `status = 'complete'` so any future partial/failed marker can't surface as the latest. */
export async function latestCompleteWindow(db: Db): Promise<number | null> {
  const rows = await db.select({ ws: cycleRuns.windowStart }).from(cycleRuns)
    .where(eq(cycleRuns.status, 'complete'))
    .orderBy(desc(cycleRuns.windowStart)).limit(1)
  return rows[0]?.ws ?? null
}

// --- aggregator reads (port of db.py's read methods — the exact inputs aggregate_window consumes) ---
//
// These feed `AggregateInputs` (aggregate.ts). The ORDER BY clauses are part of the parity contract:
//  - mentions by `thing_id` (Python `db.mentions_in_window`) — fidelity to the oracle's row stream
//    (the v2 aggregate is order-independent + sorts flair_counts, so this no longer changes output, but
//    we keep it deterministic);
//  - sov ranks by `sov DESC, ticker ASC` (Python `db.sov_ranks_at`) — this DOES drive rank_delta, so the
//    tie-break must match exactly.

/** Mentions in `[start, end)` as the aggregate's `MentionRow` tuples, ordered by `thing_id`. */
export async function readMentionsInWindow(db: Db, start: number, end: number): Promise<MentionRow[]> {
  const rows = await db.select({
    ticker: mentions.ticker, thingId: mentions.thingId, thingType: mentions.thingType,
    author: mentions.author, flair: mentions.flair, direction: mentions.direction,
  }).from(mentions)
    .where(and(gte(mentions.createdUtc, start), lt(mentions.createdUtc, end)))
    .orderBy(sql`${mentions.thingId} collate "C"`) // byte order (matches the oracle's DuckDB VARCHAR sort)
  return rows.map((r) => [r.ticker, r.thingId, r.thingType, r.author, r.flair, r.direction] as const)
}

/** Prior-window features by ticker (`features_at`) — supplies mentions(W−1) + velocity(W−1). */
export async function readFeaturesAt(db: Db, windowStart: number): Promise<PriorFeatures> {
  const rows = await db.select({
    ticker: empiricalFeatures.ticker, mentions: empiricalFeatures.mentions, velocity: empiricalFeatures.velocity,
  }).from(empiricalFeatures).where(eq(empiricalFeatures.windowStart, windowStart))
  const out: PriorFeatures = {}
  for (const r of rows) out[r.ticker] = { mentions: r.mentions, velocity: r.velocity }
  return out
}

/** Every (ticker, window_start, mentions) with `window_start < before` (`feature_history`) — baselines.
 *  Ordered for determinism; the baseline mean/variance are order-independent sums so it doesn't change z. */
export async function readFeatureHistory(db: Db, before: number): Promise<HistoryRow[]> {
  const rows = await db.select({
    ticker: empiricalFeatures.ticker, windowStart: empiricalFeatures.windowStart, mentions: empiricalFeatures.mentions,
  }).from(empiricalFeatures).where(lt(empiricalFeatures.windowStart, before))
    .orderBy(asc(empiricalFeatures.windowStart), sql`${empiricalFeatures.ticker} collate "C"`)
  return rows.map((r) => [r.ticker, r.windowStart, r.mentions ?? 0] as const)
}

/** Prior-window SoV rank by ticker, 1 = top (`sov_ranks_at`). Tie-break `sov DESC, ticker ASC` — drives
 *  rank_delta, so it MUST match the in-memory `cur_rank` tie-break (ticker) exactly. */
export async function readSovRanksAt(db: Db, windowStart: number): Promise<Record<string, number>> {
  const rows = await db.select({ ticker: empiricalFeatures.ticker }).from(empiricalFeatures)
    .where(eq(empiricalFeatures.windowStart, windowStart))
    // COLLATE "C" → byte order, matching the in-memory cur_rank tie-break (`(-sov, ticker)`); avoids a
    // locale-collation mismatch silently inverting rank_delta vs the oracle.
    .orderBy(desc(empiricalFeatures.sov), sql`${empiricalFeatures.ticker} collate "C"`)
  const out: Record<string, number> = {}
  rows.forEach((r, i) => { out[r.ticker] = i + 1 })
  return out
}

// --- signals reads (slice 7 — the Attention×Action product; NEW, no oracle) -----------------------

/** H_e leaderboard ranks at a window (1 = top), ordered by the canonical board total order — the basis
 *  for `signals.rank_delta`. Sorts in memory with `compareBoard` so the persisted ranks match the live
 *  board ordering exactly (one definition of the order, no SQL/in-memory drift). */
export async function readHeRanksAt(db: Db, windowStart: number): Promise<Record<string, number>> {
  const rows = await db.select({
    ticker: empiricalFeatures.ticker, hE: empiricalFeatures.hE, sov: empiricalFeatures.sov,
    authors: empiricalFeatures.authors, mentions: empiricalFeatures.mentions,
  }).from(empiricalFeatures).where(eq(empiricalFeatures.windowStart, windowStart))
  const sorted = [...rows].sort((a, b) => compareBoard(
    { hE: a.hE ?? 0, sov: a.sov ?? 0, authors: a.authors ?? 0, mentions: a.mentions ?? 0, ticker: a.ticker },
    { hE: b.hE ?? 0, sov: b.sov ?? 0, authors: b.authors ?? 0, mentions: b.mentions ?? 0, ticker: b.ticker },
  ))
  const out: Record<string, number> = {}
  sorted.forEach((r, i) => { out[r.ticker] = i + 1 })
  return out
}

/** Overlaid cells (those with BOTH H_e and H_m) in `[from, before)` — the population for the global
 *  rolling-median quadrant split. Inner-joins empirical⋈analytical on (ticker, window_start). */
export async function readOverlaidCells(db: Db, from: number, before: number): Promise<{ hE: number; hM: number }[]> {
  const rows = await db.select({ hE: empiricalFeatures.hE, hM: analyticalFeatures.hM })
    .from(analyticalFeatures)
    .innerJoin(empiricalFeatures, and(
      eq(analyticalFeatures.ticker, empiricalFeatures.ticker),
      eq(analyticalFeatures.windowStart, empiricalFeatures.windowStart),
    ))
    .where(and(gte(analyticalFeatures.windowStart, from), lt(analyticalFeatures.windowStart, before)))
  return rows.flatMap((r) => (r.hE != null && r.hM != null ? [{ hE: r.hE, hM: r.hM }] : []))
}

/** H_m by ticker at one window — the EFFECTIVE/preserved overlay (used when this cycle's market fetch
 *  failed and `publishCycle` is keeping the prior overlay, so signals still reflect the live H_m). */
export async function readAnalyticalHmAt(db: Db, windowStart: number): Promise<Map<string, number>> {
  const rows = await db.select({ ticker: analyticalFeatures.ticker, hM: analyticalFeatures.hM })
    .from(analyticalFeatures).where(eq(analyticalFeatures.windowStart, windowStart))
  const out = new Map<string, number>()
  for (const r of rows) if (r.hM != null) out.set(r.ticker, r.hM)
  return out
}

/** Per-ticker H_e(t)+H_m(t) series in `[from, before)` for the given tickers — the lead-lag input.
 *  H_e comes from `empirical_features` (the ticker's whole board history), H_m from `analytical_features`
 *  (its overlaid history); they're merged by window_start so each point carries whichever axes exist. */
export async function readSignalSeries(
  db: Db, tickers: readonly string[], from: number, before: number,
): Promise<Map<string, SeriesPoint[]>> {
  if (tickers.length === 0) return new Map()
  const tset = [...new Set(tickers)]
  const emp = await db.select({
    ticker: empiricalFeatures.ticker, ws: empiricalFeatures.windowStart, hE: empiricalFeatures.hE,
  }).from(empiricalFeatures).where(and(
    inArray(empiricalFeatures.ticker, tset),
    gte(empiricalFeatures.windowStart, from), lt(empiricalFeatures.windowStart, before),
  ))
  const ana = await db.select({
    ticker: analyticalFeatures.ticker, ws: analyticalFeatures.windowStart, hM: analyticalFeatures.hM,
  }).from(analyticalFeatures).where(and(
    inArray(analyticalFeatures.ticker, tset),
    gte(analyticalFeatures.windowStart, from), lt(analyticalFeatures.windowStart, before),
  ))

  const byTicker = new Map<string, Map<number, SeriesPoint>>()
  const point = (t: string, ws: number): SeriesPoint => {
    let m = byTicker.get(t)
    if (!m) { m = new Map(); byTicker.set(t, m) }
    let p = m.get(ws)
    if (!p) { p = { windowStart: ws, hE: null, hM: null }; m.set(ws, p) }
    return p
  }
  for (const r of emp) point(r.ticker, r.ws).hE = r.hE
  for (const r of ana) point(r.ticker, r.ws).hM = r.hM

  const out = new Map<string, SeriesPoint[]>()
  for (const [t, m] of byTicker) out.set(t, [...m.values()])
  return out
}

/**
 * Session-level advisory lock — the double-run guard (porting-spec §7). A session lock lives on its
 * CONNECTION, so we check out a DEDICATED client and keep it held for the worker's lifetime (returning it
 * to the pool, or an idle-timeout close, would drop the lock). Returns the held client on success (call
 * `.release()` at shutdown to drop the lock), or null if another worker already holds it. `key` is a
 * stable 64-bit int.
 */
export async function acquireAdvisoryLock(pool: Pool, key: number): Promise<PoolClient | null> {
  const client = await pool.connect()
  try {
    const res = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [key])
    if (res.rows[0]?.locked === true) return client // keep it checked out → the lock stays held
    client.release()
    return null
  } catch (e) {
    client.release()
    throw e
  }
}

/**
 * Liveness probe for the held advisory-lock connection. A session advisory lock is released the instant
 * its connection dies (managed-PG failover, `idle_session_timeout`, network drop) — silently. So a
 * trivial query is the guard: if it succeeds the session (and thus the lock) is alive; if it throws the
 * connection is gone and we've LOST the lock. (Re-running `pg_try_advisory_lock` on the same session is
 * NOT a valid check — session locks stack and it would always return true.) The worker probes each cycle
 * and exits on loss so the orchestrator restarts a clean singleton.
 */
export async function advisoryLockAlive(client: PoolClient): Promise<boolean> {
  try {
    await client.query('SELECT 1')
    return true
  } catch {
    return false
  }
}
