/**
 * Worker loop + lifecycle — TS port of `cli.cmd_run` (porting-spec §7). A standalone Node process: a
 * recursive-timeout poll loop (NEVER setInterval — no overlap), SIGTERM/SIGINT graceful shutdown,
 * per-cycle self-heal, an advisory-lock double-run guard, a startup throttle, and unhandled-rejection
 * guards. The per-cycle order is the load-bearing part:
 *
 *   poll → if !ok DISCARD whole cycle → mark poll → extract+upsert → re-aggregate W−1 (persist-only,
 *   committed BEFORE the W reads) → aggregate W → market overlay (best-effort) → atomic publish.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { AnalyticalFeatureInsert, MarketMoverInsert } from '@wsb/shared'

import { windowStartFor } from './aggregate'
import type { WorkerConfig } from './config'
import { buildExtractor, buildMarket, buildSource, loadConfig } from './config'
import {
  acquireAdvisoryLock, advisoryLockAlive, createDb, migrateToLatest, publishCycle, upsertComments,
  upsertMentions, upsertPosts, type Db,
} from './db'
import type { TickerExtractor } from './extract'
import type { Source } from './ingest'
import { log } from './logger'
import type { MarketData } from './market'
import { mentionsFromPoll } from './mentions'
import { overlayMarket, runAggregation } from './pipeline'

/** Stable 64-bit advisory-lock key ('wSBS') — the double-run guard. */
const WORKER_LOCK_KEY = 0x7753_4253

export interface CycleDeps {
  db: Db
  source: Source
  market: MarketData | null
  extractor: TickerExtractor
  bots: ReadonlySet<string>
  config: WorkerConfig
  /** Persist the poll time (the startup throttle reads it); injected so tests don't touch fs. */
  markPoll: (now: number) => void | Promise<void>
  /** Shutdown signal threaded into the poll so SIGTERM cuts an in-flight fetch short. */
  signal?: AbortSignal
}

export interface CycleResult {
  skipped: boolean
  windowStart?: number
  tickers?: number
  priced?: number
}

/**
 * One radar cycle. Returns `{skipped:true}` when the poll was incomplete (`!ok`) — that window is
 * undercounted, so it is discarded WHOLE (not persisted, aggregated, or marked) to avoid biasing the SoV
 * denominator, and retried next interval.
 */
export async function runCycle(deps: CycleDeps, now: number): Promise<CycleResult> {
  const { db, source, market, extractor, bots, config } = deps

  const poll = await source.poll(config.windowSeconds, { now, signal: deps.signal })
  if (!poll.ok) {
    log.error('poll incomplete (Arctic-Shift error mid-fetch) — skipping this cycle, will retry')
    return { skipped: true }
  }

  // Ingest atomically (raw + mentions in ONE tx) so a crash can't leave the window partially persisted —
  // a partial mention set would bias the SoV denominator. Mark the poll only AFTER it durably commits
  // (a crash before this leaves no marker → a restart retries promptly rather than throttling on nothing).
  const mentions = mentionsFromPoll(poll, extractor, bots)
  await db.transaction(async (tx) => {
    await upsertPosts(tx, poll.posts)
    await upsertComments(tx, poll.comments)
    await upsertMentions(tx, mentions)
  })
  await deps.markPoll(now)

  const ws = windowStartFor(now, config.windowSeconds)
  // Finalize the just-closed prior window first (persist-only): this poll covers the full trailing
  // window, so it carries W−1's last mentions. Its autocommit MUST land before the current window reads
  // features_at(W−1)/feature_history (pooled connections could otherwise read stale W−1) — porting-spec §7.
  await runAggregation(db, ws - config.windowSeconds, config.aggregate, { persist: true })
  const rows = await runAggregation(db, ws, config.aggregate, { persist: false })

  let analytical: AnalyticalFeatureInsert[] | undefined
  let movers: MarketMoverInsert[] | undefined
  if (market && rows.length) {
    try {
      const o = await overlayMarket(market, ws, rows, config.market, now)
      // EMPTY analytical means every snapshot chunk failed (snapshots() swallows non-200s) — treat it as
      // a total market failure and PRESERVE the prior overlay (leave `analytical` undefined), exactly as a
      // thrown error would. Only a non-empty overlay replaces the window's analytical rows; a genuinely
      // shrunk top-N (fewer but ≥1 rows) still replaces and clears the stale tickers.
      if (o.analytical.length) analytical = o.analytical
      else log.warn('market overlay returned no priced tickers — preserving prior overlay')
      movers = o.movers
    } catch (e) {
      // best-effort: a market failure must NEVER kill the cycle. Leaving `analytical` undefined makes
      // publishCycle PRESERVE the prior overlay (never-kill) rather than wipe it (porting-spec §5/§7).
      log.warn({ err: String(e) }, 'market overlay failed this cycle — publishing empirical-only')
    }
  }

  const totalMentions = rows.reduce((s, r) => s + r.mentions, 0)
  await publishCycle(db, {
    meta: {
      windowStart: ws,
      generatedAt: now,
      totalMentions,
      quiet: totalMentions < config.minWindowMentions,
      capped: poll.capped,
      newestUtc: poll.newestUtc,
    },
    features: rows,
    analytical,
    movers,
  })

  const lag = poll.newestUtc != null ? now - poll.newestUtc : null
  const hb = lag == null ? 'NO-DATA' : lag <= config.maxStalenessSeconds ? 'OK' : 'STALE'
  const top = rows[0]
  log.info({
    posts: poll.posts.length, comments: poll.comments.length, mentions: mentions.length,
    tickers: rows.length, priced: analytical?.length ?? 0, capped: poll.capped,
    top: top ? `${top.ticker} H_e=${top.hE.toFixed(2)}` : '—',
    lagMin: lag != null ? Math.floor(lag / 60) : null, freshness: hb,
  }, 'cycle complete')
  if (hb !== 'OK') {
    log.error({ freshness: hb }, 'freshness degraded — Arctic-Shift is the sole live tap; see README runbook')
  }

  return { skipped: false, windowStart: ws, tickers: rows.length, priced: analytical?.length ?? 0 }
}

// --- poll-time marker (startup throttle state) -----------------------------------------------------

/** Persisted epoch of the most recent poll, or null. Survives restarts (data/.last_poll). */
export function lastPollAt(dataDir: string): number | null {
  try {
    const t = readFileSync(join(dataDir, '.last_poll'), 'utf8').trim()
    if (!t) return null
    const v = Number(t)
    return Number.isFinite(v) ? Math.trunc(v) : null
  } catch {
    return null
  }
}

export function markPoll(dataDir: string, ts: number): void {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, '.last_poll'), String(ts))
}

// --- the loop --------------------------------------------------------------------------------------

/** A sleep that resolves early when `signal` aborts (so SIGTERM doesn't wait out a full interval). */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export interface LoopOptions {
  once?: boolean
  intervalSeconds: number
  minPollGapSeconds: number
  dataDir: string
  /** Injectable for tests: wall clock (epoch seconds) + sleep. */
  clock?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /** Injectable for tests: install process signal/error handlers (default: real `process`). */
  installHandlers?: boolean
  /** Optional external stop trigger — aborting it requests the SAME graceful shutdown as SIGTERM. */
  stopSignal?: AbortSignal
  /** Per-cycle advisory-lock liveness probe. Returning false (lock lost) stops the loop so the caller
   *  can exit non-zero and let the orchestrator restart a clean singleton (the double-run guard). */
  lockAlive?: () => Promise<boolean>
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

/**
 * Run the poll loop until SIGTERM/SIGINT (or `once`). Each cycle is wrapped in try/catch so a transient
 * fault self-heals on the next interval rather than crashing the daemon. The loop closes the source/market
 * on exit; the caller owns the DB (and the advisory-lock connection).
 */
export async function runLoop(deps: CycleDeps, opts: LoopOptions): Promise<void> {
  const clock = opts.clock ?? nowSeconds
  const sleep = opts.sleep ?? abortableSleep
  const install = opts.installHandlers ?? true

  const ac = new AbortController()
  let stopping = false
  const stop = (): void => {
    stopping = true
    ac.abort()
  }
  // A stray unhandled rejection (outside the per-cycle try/catch) shouldn't kill the daemon — log it.
  const onRejection = (r: unknown): void =>
    log.error({ err: String(r) }, 'unhandledRejection — guarded; the daemon keeps running')
  // An uncaughtException means undefined process state — log and EXIT non-zero so the orchestrator
  // restarts a clean process (continuing risks publishing corrupt/stale cycles).
  const onException = (e: unknown): void => {
    log.error({ err: String(e) }, 'uncaughtException — exiting for a clean restart')
    process.exit(1)
  }

  if (install) {
    process.on('SIGTERM', stop)
    process.on('SIGINT', stop)
    process.on('unhandledRejection', onRejection)
    process.on('uncaughtException', onException)
  }
  opts.stopSignal?.addEventListener('abort', stop, { once: true })

  try {
    // Startup throttle: after a rapid restart, wait out the min gap since the last poll. Ignore a
    // future-dated marker (clock skew / corruption) rather than translating it into an unbounded sleep.
    const last = lastPollAt(opts.dataDir)
    if (last != null) {
      const elapsed = clock() - last
      if (elapsed < 0) {
        log.warn({ ahead: -elapsed }, 'startup throttle: .last_poll is in the future (clock skew?) — ignoring')
      } else if (elapsed < opts.minPollGapSeconds) {
        const wait = opts.minPollGapSeconds - elapsed
        log.info({ elapsed, wait }, 'startup throttle: waiting before first pull')
        await sleep(wait * 1000, ac.signal)
      }
    }

    while (!stopping) {
      // Verify we still hold the advisory lock before doing any work. A session lock drops silently when
      // its connection dies (failover / idle timeout); if it's gone, stop so the caller can exit and let
      // the orchestrator restart a single clean writer.
      if (opts.lockAlive && !(await opts.lockAlive())) {
        log.error('advisory lock lost (connection dropped) — stopping so a clean singleton can restart')
        break
      }
      const t0 = clock()
      try {
        await runCycle({ ...deps, signal: ac.signal }, t0)
      } catch (e) {
        log.error({ err: String(e) }, 'cycle failed — recovering, will retry next interval')
      }
      if (opts.once || stopping) break
      await sleep(Math.max(5000, opts.intervalSeconds * 1000 - (clock() - t0) * 1000), ac.signal)
    }
  } finally {
    if (install) {
      process.off('SIGTERM', stop)
      process.off('SIGINT', stop)
      process.off('unhandledRejection', onRejection)
      process.off('uncaughtException', onException)
    }
    opts.stopSignal?.removeEventListener('abort', stop)
    await deps.source.close()
    if (deps.market) await deps.market.close()
  }
}

export interface StartOptions {
  root?: string
  once?: boolean
  noMarket?: boolean
}

/**
 * Assemble the worker from config + env, acquire the advisory lock, and run the loop. The DB pool (and
 * thus the held advisory-lock connection) is closed on exit. Returns early without running if another
 * instance already holds the lock.
 */
export async function startWorker(opts: StartOptions = {}): Promise<void> {
  const root = opts.root ?? process.cwd()
  const { raw, env, worker } = loadConfig(root)

  const dbUrl = env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL is required (the Postgres connection string)')
  const handle = createDb(dbUrl)
  await migrateToLatest(handle.db)

  const lockClient = await acquireAdvisoryLock(handle.pool, WORKER_LOCK_KEY)
  if (!lockClient) {
    log.error('another worker already holds the advisory lock — exiting (double-run guard)')
    await handle.close()
    return
  }

  const source = buildSource(raw)
  const market = opts.noMarket ? null : buildMarket(raw, env)
  if (!market && !opts.noMarket) log.warn('market overlay disabled — ALPACA creds missing (empirical-only)')
  const extractor = buildExtractor(raw, root)

  log.info({ interval: worker.pollSeconds, windowMin: worker.windowSeconds / 60, market: Boolean(market) },
    'run loop starting (forward-only; SIGTERM/Ctrl-C to stop)')

  let lockLost = false
  try {
    await runLoop(
      {
        db: handle.db, source, market, extractor, bots: worker.bots, config: worker,
        markPoll: (ts) => markPoll(worker.dataDir, ts),
      },
      {
        once: opts.once,
        intervalSeconds: worker.pollSeconds,
        minPollGapSeconds: worker.minPollGapSeconds,
        dataDir: worker.dataDir,
        lockAlive: async () => {
          const ok = await advisoryLockAlive(lockClient)
          if (!ok) lockLost = true
          return ok
        },
      },
    )
  } finally {
    if (!lockLost) lockClient.release() // a dead connection can't be released back to the pool
    await handle.close()
  }
  if (lockLost) process.exitCode = 1 // signal the orchestrator to restart a clean singleton
}
