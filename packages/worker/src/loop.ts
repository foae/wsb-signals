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
import type { PlaysConfig, WorkerConfig } from './config'
import { buildExtractor, buildMarket, buildSource, findRoot, loadConfig, loadWhitelistSet } from './config'
import {
  acquireAdvisoryLock, advisoryLockAlive, createDb, migrateToLatest, publishCycle, upsertComments,
  upsertMentions, upsertPosts, verifyPublished, type Db,
} from './db'
import { ensureReadRole } from './ensure-read-role'
import type { TickerExtractor } from './extract'
import type { Source } from './ingest'
import { log } from './logger'
import type { MarketData } from './market'
import { mentionsFromPoll } from './mentions'
import { buildSignals, overlayMarket, runAggregation } from './pipeline'
import { capturePlays } from './plays/capture'
import { buildAnalyzer } from './plays/analyzer'
import { runPlaysQueue } from './plays/queue'
import { abortableSleep } from './timing'

export { abortableSleep } from './timing'

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
  /** Plays capture (P1) — undefined when [plays] is disabled. `db` is the DEDICATED plays pool
   *  (invariant P9); the capture insert itself is best-effort and never throws (invariant P1). */
  plays?: { db: Db; config: PlaysConfig }
  /** Shutdown signal threaded into the poll so SIGTERM cuts an in-flight fetch short. */
  signal?: AbortSignal
}

export interface CycleResult {
  skipped: boolean
  windowStart?: number
  tickers?: number
  priced?: number
  /** Post-publish read-back verdict — false means the persisted board diverged from the published one. */
  readbackOk?: boolean
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
    // Plays capture keys on the POSTS-side fetch succeeding, not the whole poll: the whole-poll discard
    // protects the SoV denominator, which capture doesn't touch — a prolonged comments-side failure must
    // not lose a window of plays whose media is meanwhile being deleted (plays-plan §3, invariant P7).
    if (deps.plays && poll.postsOk) {
      await capturePlays(deps.plays.db, poll.rawPosts, deps.plays.config, now)
    }
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

  // Attention×Action signals (slice 7): divergence / quadrant / lead-lag from the board + the effective
  // H_m (fresh overlay, or the preserved prior when `analytical` is undefined). Computed before the publish
  // so it lands in the SAME atomic transaction.
  const signals = await buildSignals(db, ws, config.windowSeconds, config.signals, rows, analytical)

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
    signals,
  })

  // Post-publish read-back: re-read what landed in Postgres and diff it against the board just published.
  // Catches write-path bugs (NULL h_e, JSONB round-trips, BIGINT coercion, a missing publish marker) the
  // cycle they happen — the web reads exactly what this re-reads. ~4 cheap window reads per cycle.
  const readback = await verifyPublished(db, ws, { features: rows, analytical, signals })
  if (!readback.ok) {
    log.error({ windowStart: ws, diffs: readback.diffs.length, cycleRun: readback.cycle_run },
      'READ-BACK mismatch — persisted board diverges from the published board (write-path bug)')
  }

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

  // Plays capture: a best-effort ON CONFLICT DO NOTHING insert, OUTSIDE every radar transaction and
  // AFTER publishCycle committed — inside it, a plays-table error would roll back the radar cycle
  // (invariant P1). capturePlays never throws (plays-plan §3).
  if (deps.plays) {
    await capturePlays(deps.plays.db, poll.rawPosts, deps.plays.config, now)
  }

  return {
    skipped: false, windowStart: ws, tickers: rows.length, priced: analytical?.length ?? 0,
    readbackOk: readback.ok,
  }
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

export interface LoopOptions {
  once?: boolean
  intervalSeconds: number
  minPollGapSeconds: number
  dataDir: string
  /** Injectable for tests: wall clock (epoch seconds) + sleep. */
  clock?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /** External stop trigger — aborting it requests graceful shutdown. Process-level wiring (SIGTERM →
   *  abort, uncaughtException guards) lives in `index.ts`, which OWNS all process handlers — the loops
   *  never install their own (plays-plan §1: a second copy per loop would race shutdown). */
  stopSignal?: AbortSignal
  /** Per-cycle advisory-lock liveness probe. Returning false (lock lost) stops the loop so the caller
   *  can exit non-zero and let the orchestrator restart a clean singleton (the double-run guard). */
  lockAlive?: () => Promise<boolean>
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

/**
 * Run the poll loop until `stopSignal` aborts (or `once`). Each cycle is wrapped in try/catch so a
 * transient fault self-heals on the next interval rather than crashing the daemon. The loop closes the
 * source/market on exit; the caller owns the DB (and the advisory-lock connection). Process-level
 * handlers (SIGTERM/SIGINT, uncaughtException) are `index.ts`'s job, not this loop's (plays-plan §1).
 */
export async function runLoop(deps: CycleDeps, opts: LoopOptions): Promise<void> {
  const clock = opts.clock ?? nowSeconds
  const sleep = opts.sleep ?? abortableSleep

  const ac = new AbortController()
  let stopping = false
  const stop = (): void => {
    stopping = true
    ac.abort()
  }
  opts.stopSignal?.addEventListener('abort', stop, { once: true })
  if (opts.stopSignal?.aborted) stop() // a signal aborted BEFORE attach fires no event — honor it too

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
    opts.stopSignal?.removeEventListener('abort', stop)
    await deps.source.close()
    if (deps.market) await deps.market.close()
  }
}

export interface StartOptions {
  root?: string
  once?: boolean
  noMarket?: boolean
  /** External shutdown trigger (index.ts aborts it on SIGTERM/SIGINT — it owns the process handlers). */
  stopSignal?: AbortSignal
}

/**
 * Assemble the worker from config + env, acquire the advisory lock, and run the loops — the radar loop
 * plus, when `[plays]` is enabled, the plays queue on its OWN pool (invariant P9; both under the same
 * advisory lock). The pools (and thus the held advisory-lock connection) are closed on exit, after every
 * loop has wound down. Returns early without running if another instance already holds the lock.
 */
export async function startWorker(opts: StartOptions = {}): Promise<void> {
  const root = opts.root ?? findRoot()
  const { raw, env, worker } = loadConfig(root)

  const dbUrl = env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL is required (the Postgres connection string)')
  const handle = createDb(dbUrl)
  await migrateToLatest(handle.db)
  // Self-healing read-only role for the web (no-op unless WEB_RO_* set). Must run after migrations so the
  // GRANT SELECT covers all current tables; ALTER DEFAULT PRIVILEGES covers future ones (ensure-read-role.ts).
  await ensureReadRole(handle.pool, env.WEB_RO_USER, env.WEB_RO_PASSWORD)

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

  // Dedicated plays pool (invariant P9): a plays query can never starve the radar pool, whose advisory
  // lock permanently holds one client. Same DB, same writer role — just separate connections, WITH
  // deadlines: `capturePlays` is awaited on the radar cycle's path, and its try/catch only covers a
  // query that FAILS — these bounds make a wedged pool fail instead of hanging the radar (P1).
  const playsHandle = worker.plays.enabled
    ? createDb(dbUrl, { connectionTimeoutMillis: 10_000, statement_timeout: 15_000, query_timeout: 20_000 })
    : null
  if (!worker.plays.enabled) log.info('plays disabled ([plays].enabled = false) — radar only')

  // The LLM seam (P2): wired only with credentials — without them the queue runs media-only and
  // warns per tick about the resting media_ready backlog. Fail-closed metering sits behind this.
  let analyzer
  try {
    analyzer = playsHandle
      ? buildAnalyzer({
        provider: worker.plays.llm.provider,
        extractModel: worker.plays.llm.extractModel,
        interpretModel: worker.plays.llm.interpretModel,
        maxOutputTokens: worker.plays.llm.maxOutputTokens,
      }, env)
      : undefined
  } catch (e) {
    // A plays-only config fault (unknown provider) must not keep the RADAR from starting (P1).
    log.error({ err: String(e) }, 'plays analyzer construction failed — extraction OFF, radar unaffected')
    analyzer = undefined
  }
  const whitelistSet = loadWhitelistSet(raw, root)
  if (playsHandle && !whitelistSet) {
    // Same failure mode buildExtractor warns about, but for the VALIDATION pass: without the
    // whitelist every equity ticker validates as `unvalidated` (0.5 confidence) — visibly degraded
    // output from an invisible cause unless named here.
    log.warn('plays ticker validation degraded — whitelist missing, every equity will be `unvalidated` (run build-whitelist)')
  }
  const isListedTicker = (t: string): boolean => whitelistSet?.has(t) ?? false

  log.info({ interval: worker.pollSeconds, windowMin: worker.windowSeconds / 60, market: Boolean(market),
    plays: Boolean(playsHandle) }, 'run loop starting (forward-only; SIGTERM/Ctrl-C to stop)')

  // Internal stop: fires on the external stopSignal AND when the radar loop exits (once mode / lock
  // lost), so the plays queue never outlives the radar's lifecycle.
  const internal = new AbortController()
  const onExternalStop = (): void => internal.abort()
  opts.stopSignal?.addEventListener('abort', onExternalStop, { once: true })

  let lockLost = false
  try {
    const radar = runLoop(
      {
        db: handle.db, source, market, extractor, bots: worker.bots, config: worker,
        markPoll: (ts) => markPoll(worker.dataDir, ts),
        plays: playsHandle ? { db: playsHandle.db, config: worker.plays } : undefined,
      },
      {
        once: opts.once,
        intervalSeconds: worker.pollSeconds,
        minPollGapSeconds: worker.minPollGapSeconds,
        dataDir: worker.dataDir,
        stopSignal: internal.signal,
        lockAlive: async () => {
          const ok = await advisoryLockAlive(lockClient)
          if (!ok) lockLost = true
          return ok
        },
      },
    ).finally(() => internal.abort())

    if (opts.once) {
      // Deterministic single-shot: one radar cycle (which captures), THEN one queue tick (which archives
      // media) — running them in parallel would give the tick nothing to claim.
      await radar
      if (playsHandle) {
        // The EXTERNAL stop signal, not `internal` — internal is already aborted by radar completing
        // (the .finally above), which must not suppress the tick; SIGTERM still must abort it.
        await runPlaysQueue({
          db: playsHandle.db, config: worker.plays, analyzer, isListedTicker,
          market, windowSeconds: worker.windowSeconds,
        }, {
          once: true, stopSignal: opts.stopSignal ?? new AbortController().signal,
        })
      }
    } else {
      const queue = playsHandle
        ? runPlaysQueue(
          {
            db: playsHandle.db, config: worker.plays, analyzer, isListedTicker,
            market, windowSeconds: worker.windowSeconds,
          },
          { stopSignal: internal.signal })
        : Promise.resolve()
      // allSettled, not all: if one loop rejects, the other must still wind down BEFORE the finally
      // closes the pools under it. The radar's `.finally` above stops the queue on any radar exit.
      const results = await Promise.allSettled([radar, queue])
      const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
      if (rejected) throw rejected.reason
    }
  } finally {
    opts.stopSignal?.removeEventListener('abort', onExternalStop)
    if (!lockLost) lockClient.release() // a dead connection can't be released back to the pool
    await handle.close()
    await playsHandle?.close()
  }
  if (lockLost) process.exitCode = 1 // signal the orchestrator to restart a clean singleton
}
