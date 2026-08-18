/**
 * Plays queue (P1 skeleton, plays-plan §3) — the second loop in the worker process, structurally
 * isolated from the radar (invariant P1 via P9):
 *
 *  - **Own PG pool** (the caller passes a dedicated handle): a plays query can never starve the radar
 *    pool, whose advisory lock permanently holds one client.
 *  - **Recursive-timeout tick, never setInterval**: once LLM stages land (P2), a tick with several
 *    vision calls can easily outlast the interval, and overlapping ticks double-process = double-spend.
 *  - **`FOR UPDATE SKIP LOCKED` claim under a lease**: `claimed_at` marks the claim; a claim older than
 *    `lease_minutes` is re-claimable, so a crash mid-stage can't strand rows as claimed-forever. The
 *    lease also makes the queue tolerate a second process (the documented P1 escape hatch).
 *  - **Every advance guards the FROM-status** (`where status = <expected>`), so no writer ever moves
 *    `status` backwards (invariant P8), even racing a stale-lease re-claimer.
 *  - **`failed` is terminal only after `max_attempts`** stage crashes; `attempts`/`next_attempt_at`
 *    drive exponential backoff between tries. Media trouble is NOT a stage crash: it lives in
 *    `media_status` and degrades to text-only after the `media_retry_until` window (invariant P7).
 *  - **The tick body is the exception boundary**: a repeatedly-throwing tick disables the plays loop
 *    with a loud log; the radar keeps running (plays-plan §1).
 *
 * P1 processes exactly one stage, `captured → media_ready`. The LLM stages (`media_ready → extracted →
 * analyzed → published`) land at P2/P3 behind the PlayAnalyzer seam — rows rest at `media_ready` until
 * then. No transaction is ever held across the media fetches (invariant P9): the claim is one short tx,
 * the stage is fetch+fs only, the advance is one autocommit UPDATE.
 */
import { and, asc, eq, inArray, isNull, lt, lte, or } from 'drizzle-orm'

import { plays, type PlayMediaItem, type PlayRow } from '@wsb/shared'

import type { PlaysConfig } from '../config'
import type { Db } from '../db'
import { log } from '../logger'
import { abortableSleep } from '../timing'
import { runMediaStage, type Fetcher, type MediaStageResult } from './media'

/** Rows claimed per tick. A constant, not config: the media stage is cheap I/O (P2's LLM stages get the
 *  configured `max_plays_per_tick` knob instead). At ~45 plays/day this clears any realistic backlog. */
const CLAIM_BATCH = 10
/** Re-poll cadence for a transiently-failing media fetch inside the media_retry_until window. */
const MEDIA_RETRY_INTERVAL_S = 60
/** Backoff for stage crashes: 60s · 2^(attempts−1), capped. */
const FAILURE_BACKOFF_BASE_S = 60
const FAILURE_BACKOFF_CAP_S = 3600
/** Consecutive whole-tick failures before the plays loop disables itself (the radar keeps running). */
const MAX_CONSECUTIVE_TICK_FAILURES = 5

export interface QueueDeps {
  /** The DEDICATED plays pool — never the radar's (invariant P9). */
  db: Db
  config: PlaysConfig
  /** Injectable for tests. */
  clock?: () => number
  fetchImpl?: Fetcher
  media?: typeof runMediaStage
  /** Shutdown: stop claiming new rows; the in-flight row's fetches abort (cheap to redo — the full
   *  two-phase drain matters once LLM calls exist, P2). */
  signal?: AbortSignal
}

export interface TickStats {
  claimed: number
  advanced: number // reached media_ready this tick (archived / degraded / text-only)
  retrying: number // transient media failure, still inside the retry window
  failed: number // stage crashes that hit max_attempts (terminal)
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

/**
 * Claim up to `CLAIM_BATCH` due `captured` rows: not claimed (or lease-expired) and past
 * `next_attempt_at`. One short transaction — SELECT … FOR UPDATE SKIP LOCKED + the claim-stamp UPDATE —
 * so concurrent claimers (a second process, a stale-lease race) partition rows instead of blocking.
 */
export async function claimCaptured(db: Db, config: PlaysConfig, now: number): Promise<PlayRow[]> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(plays)
      .where(and(
        eq(plays.status, 'captured'),
        or(isNull(plays.nextAttemptAt), lte(plays.nextAttemptAt, now)),
        or(isNull(plays.claimedAt), lt(plays.claimedAt, now - config.leaseSeconds)),
      ))
      .orderBy(asc(plays.createdUtc), asc(plays.id))
      .limit(CLAIM_BATCH)
      .for('update', { skipLocked: true })
    if (rows.length) {
      await tx.update(plays).set({ claimedAt: now }).where(inArray(plays.id, rows.map((r) => r.id)))
    }
    return rows
  })
}

/** Advance a claimed `captured` row to `media_ready` with its final media verdict. The status guard in
 *  the WHERE makes this a no-op if anything else already moved the row (never-backwards, P8). */
async function advanceToMediaReady(
  db: Db, row: PlayRow, mediaStatus: 'archived' | 'failed' | 'none', items: PlayMediaItem[], now: number,
): Promise<void> {
  await db.update(plays).set({
    status: 'media_ready',
    mediaStatus,
    media: items.length ? items : null,
    claimedAt: null,
    nextAttemptAt: now, // the next stage (P2 extract) is due immediately once it exists
    attempts: 0, // attempts budget is per stage
    error: null,
  }).where(and(eq(plays.id, row.id), eq(plays.status, 'captured')))
}

/** Reschedule a transiently-failing media fetch inside its retry window (status stays `captured`). */
async function scheduleMediaRetry(db: Db, row: PlayRow, retryUntil: number, now: number): Promise<void> {
  await db.update(plays).set({
    mediaRetryUntil: retryUntil,
    nextAttemptAt: now + MEDIA_RETRY_INTERVAL_S,
    claimedAt: null,
  }).where(and(eq(plays.id, row.id), eq(plays.status, 'captured')))
}

/** Record a stage crash: bump `attempts`, back off exponentially, and only at `max_attempts` park the
 *  row as terminally `failed` — a single transient throw must not permanently kill a play. */
async function recordStageFailure(db: Db, row: PlayRow, config: PlaysConfig, now: number, err: unknown): Promise<boolean> {
  const attempts = (row.attempts ?? 0) + 1
  const terminal = attempts >= config.maxAttempts
  const backoff = Math.min(FAILURE_BACKOFF_BASE_S * 2 ** (attempts - 1), FAILURE_BACKOFF_CAP_S)
  await db.update(plays).set({
    attempts,
    error: String(err).slice(0, 500),
    claimedAt: null,
    nextAttemptAt: now + backoff,
    ...(terminal ? { status: 'failed' as const } : {}),
  }).where(and(eq(plays.id, row.id), eq(plays.status, row.status)))
  return terminal
}

/** The `captured` stage: resolve + archive media, then advance / retry / degrade per invariant P7. */
async function processCaptured(deps: QueueDeps, row: PlayRow, now: number): Promise<'advanced' | 'retrying'> {
  const media = deps.media ?? runMediaStage
  const r: MediaStageResult = await media(row, {
    config: deps.config, fetchImpl: deps.fetchImpl, signal: deps.signal,
  })

  if (r.none) {
    await advanceToMediaReady(deps.db, row, 'none', [], now)
    return 'advanced'
  }
  if (r.retryable) {
    const retryUntil = row.mediaRetryUntil ?? now + deps.config.mediaRetrySeconds
    if (now < retryUntil) {
      log.warn({ playId: row.id, detail: r.detail, retryUntil }, 'plays media transient failure — will retry')
      await scheduleMediaRetry(deps.db, row, retryUntil, now)
      return 'retrying'
    }
    // Window exhausted: keep whatever was archived; an empty set degrades to text-only (invariant P7).
  }
  const status = r.items.length ? 'archived' : 'failed'
  if (status === 'failed') {
    log.warn({ playId: row.id, detail: r.detail }, 'plays media unrecoverable — degrading to text-only')
  } else if (r.detail) {
    log.warn({ playId: row.id, archived: r.items.length, detail: r.detail }, 'plays media partially archived')
  }
  await advanceToMediaReady(deps.db, row, status, r.items, now)
  return 'advanced'
}

/** One queue tick: claim due rows, run each row's stage with a per-row exception boundary. */
export async function runQueueTick(deps: QueueDeps): Promise<TickStats> {
  const clock = deps.clock ?? nowSeconds
  const stats: TickStats = { claimed: 0, advanced: 0, retrying: 0, failed: 0 }
  const claimed = await claimCaptured(deps.db, deps.config, clock())
  stats.claimed = claimed.length
  for (const row of claimed) {
    if (deps.signal?.aborted) break // drain: stop starting rows; unprocessed claims lapse via the lease
    try {
      const outcome = await processCaptured(deps, row, clock())
      if (outcome === 'advanced') stats.advanced++
      else stats.retrying++
    } catch (e) {
      const terminal = await recordStageFailure(deps.db, row, deps.config, clock(), e)
      if (terminal) stats.failed++
      log.error({ playId: row.id, err: String(e), terminal }, 'plays stage crashed')
    }
  }
  if (stats.claimed > 0) log.info(stats, 'plays queue tick')
  return stats
}

export interface PlaysQueueOptions {
  once?: boolean
  stopSignal: AbortSignal
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/**
 * The plays queue loop. Runs until `stopSignal` aborts (the worker's shared shutdown) — or disables
 * ITSELF after `MAX_CONSECUTIVE_TICK_FAILURES` whole-tick crashes, loudly, leaving the radar loop
 * untouched (plays-plan §1). Queue-level backpressure: an unprocessed backlog just waits — rows are
 * re-claimed next tick.
 */
export async function runPlaysQueue(deps: QueueDeps, opts: PlaysQueueOptions): Promise<void> {
  const sleep = opts.sleep ?? abortableSleep
  let consecutiveFailures = 0
  log.info({ intervalS: deps.config.queueIntervalSeconds }, 'plays queue starting')
  while (!opts.stopSignal.aborted) {
    try {
      await runQueueTick({ ...deps, signal: opts.stopSignal })
      consecutiveFailures = 0
    } catch (e) {
      consecutiveFailures++
      log.error({ err: String(e), consecutiveFailures }, 'plays queue tick failed')
      if (consecutiveFailures >= MAX_CONSECUTIVE_TICK_FAILURES) {
        log.error('plays queue DISABLED after repeated tick failures — radar unaffected; restart the worker to resume')
        return
      }
    }
    if (opts.once) return
    await sleep(deps.config.queueIntervalSeconds * 1000, opts.stopSignal)
  }
}
