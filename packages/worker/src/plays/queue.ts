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
  retrying: number // transient media failure (still inside the retry window) or a shutdown release
  failed: number // stage crashes that hit max_attempts (terminal)
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

/**
 * Claim up to `CLAIM_BATCH` due `captured` rows: not claimed (or lease-expired) and past
 * `next_attempt_at`. One short transaction — SELECT … FOR UPDATE SKIP LOCKED + the claim-stamp UPDATE —
 * so concurrent claimers (a second process, a stale-lease race) partition rows instead of blocking.
 * The returned rows carry the NEW `claimedAt`: it is this claimer's fence token — every later update
 * guards on it, so a claimer that lost its lease mid-stage can't clobber the re-claimer's work.
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
    return rows.map((r) => ({ ...r, claimedAt: now }))
  })
}

/** This claimer's WHERE fence: right row, still in the from-status, still OUR claim. The claim fence is
 *  what keeps a lease-expired straggler from mutating rows a re-claimer now owns; the status guard is
 *  the never-backwards rule (P8). A fenced-out update is a silent no-op — exactly right. */
const ownedBy = (row: PlayRow): ReturnType<typeof and> =>
  and(eq(plays.id, row.id), eq(plays.status, row.status), eq(plays.claimedAt, row.claimedAt!))

/** A fenced update matching no row means THIS claimer lost its lease mid-stage and a re-claimer owns
 *  the row — the no-op is correct (see `ownedBy`), but without a log line the double-claim is
 *  invisible when debugging from logs alone. */
const warnIfFenced = (res: { rowCount: number | null }, row: PlayRow, action: string): boolean => {
  const fenced = (res.rowCount ?? 0) === 0
  if (fenced) log.warn({ playId: row.id, action }, 'plays update fenced out — lease lost mid-stage, row re-claimed elsewhere; no-op')
  return fenced
}

/** Advance a claimed `captured` row to `media_ready` with its final media verdict. */
async function advanceToMediaReady(
  db: Db, row: PlayRow, mediaStatus: 'archived' | 'failed' | 'none', items: PlayMediaItem[], now: number,
): Promise<void> {
  const res = await db.update(plays).set({
    status: 'media_ready',
    mediaStatus,
    media: items.length ? items : null,
    claimedAt: null,
    nextAttemptAt: now, // the next stage (P2 extract) is due immediately once it exists
    attempts: 0, // attempts budget is per stage
    error: null,
  }).where(ownedBy(row))
  // The one per-play success line: without it the COMMON outcome (clean archive) is invisible in logs
  // and a play's id can't be traced from capture to media_ready.
  if (!warnIfFenced(res, row, 'advance')) {
    log.info({ playId: row.id, mediaStatus, images: items.length, isGallery: row.isGallery === true },
      'play advanced to media_ready')
  }
}

/** Reschedule a transiently-failing media fetch inside its retry window (status stays `captured`).
 *  Any items archived THIS attempt are persisted so the next attempt reuses instead of re-fetching —
 *  and so an image deleted upstream between attempts is never lost from the manifest. */
async function scheduleMediaRetry(
  db: Db, row: PlayRow, retryUntil: number, items: PlayMediaItem[], now: number,
): Promise<void> {
  const res = await db.update(plays).set({
    mediaRetryUntil: retryUntil,
    nextAttemptAt: now + MEDIA_RETRY_INTERVAL_S,
    claimedAt: null,
    ...(items.length ? { media: items } : {}), // never clobber prior items with an empty attempt
  }).where(ownedBy(row))
  warnIfFenced(res, row, 'media-retry')
}

/** Release a shutdown-aborted claim UNCHANGED: not a fault (no attempts, no retry window), just due
 *  again on the next tick after restart. Advancing here would degrade the play to text-only over a
 *  plain deploy (P7); items archived before the abort are persisted for reuse. */
async function releaseClaim(db: Db, row: PlayRow, items: PlayMediaItem[], now: number): Promise<void> {
  const res = await db.update(plays).set({
    claimedAt: null,
    nextAttemptAt: now,
    ...(items.length ? { media: items } : {}),
  }).where(ownedBy(row))
  warnIfFenced(res, row, 'release')
}

/** Record a stage crash: bump `attempts`, back off exponentially, and only at `max_attempts` park the
 *  row as terminally `failed` — a single transient throw must not permanently kill a play. */
async function recordStageFailure(db: Db, row: PlayRow, config: PlaysConfig, now: number, err: unknown): Promise<boolean> {
  const attempts = (row.attempts ?? 0) + 1
  const terminal = attempts >= config.maxAttempts
  const backoff = Math.min(FAILURE_BACKOFF_BASE_S * 2 ** (attempts - 1), FAILURE_BACKOFF_CAP_S)
  const res = await db.update(plays).set({
    attempts,
    error: String(err).slice(0, 500),
    claimedAt: null,
    nextAttemptAt: now + backoff,
    ...(terminal ? { status: 'failed' as const } : {}),
  }).where(ownedBy(row))
  warnIfFenced(res, row, 'record-failure')
  return terminal
}

/** The `captured` stage: resolve + archive media, then advance / retry / release / degrade (P7). */
async function processCaptured(deps: QueueDeps, row: PlayRow, now: number): Promise<'advanced' | 'retrying'> {
  const media = deps.media ?? runMediaStage
  const r: MediaStageResult = await media(row, {
    config: deps.config, fetchImpl: deps.fetchImpl, signal: deps.signal,
  })

  if (r.aborted) {
    log.info({ playId: row.id, archived: r.items.length }, 'plays media stage aborted (shutdown) — releasing claim')
    await releaseClaim(deps.db, row, r.items, now)
    return 'retrying'
  }
  if (r.none) {
    await advanceToMediaReady(deps.db, row, 'none', [], now)
    return 'advanced'
  }
  if (r.retryable) {
    const retryUntil = row.mediaRetryUntil ?? now + deps.config.mediaRetrySeconds
    if (now < retryUntil) {
      log.warn({ playId: row.id, detail: r.detail, retryUntil }, 'plays media transient failure — will retry')
      await scheduleMediaRetry(deps.db, row, retryUntil, r.items, now)
      return 'retrying'
    }
    // Window exhausted: keep whatever was archived; an empty set degrades to text-only (invariant P7).
  }
  // Prior-attempt items (persisted on retry scheduling) still count when THIS attempt resolved nothing.
  const priorItems = Array.isArray(row.media) ? (row.media as PlayMediaItem[]) : []
  const items = r.items.length ? r.items : priorItems
  const status = items.length ? 'archived' : 'failed'
  if (status === 'failed') {
    log.warn({ playId: row.id, detail: r.detail }, 'plays media unrecoverable — degrading to text-only')
  } else if (r.detail) {
    log.warn({ playId: row.id, archived: items.length, detail: r.detail }, 'plays media partially archived')
  }
  await advanceToMediaReady(deps.db, row, status, items, now)
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
      log.error({ playId: row.id, err: String(e), attempts: (row.attempts ?? 0) + 1, terminal }, 'plays stage crashed')
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
