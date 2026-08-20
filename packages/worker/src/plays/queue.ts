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
 * Three stages: `captured → media_ready` (P1, media), `media_ready → extracted` (P2, vision LLM),
 * `extracted → published` (P3, evidence + interpret LLM + the denormalize/publish row update).
 * There is deliberately NO intermediate status between interpret and publish — plan §5 pins
 * `published_at` + the current-run pointers + the denormalized board fields into ONE row update, so
 * publish IS the interpret stage's advance. No transaction is ever held across media fetches or LLM
 * calls (invariant P9).
 */
import { and, asc, count, eq, inArray, isNull, lt, lte, or } from 'drizzle-orm'

import { playExtractions, playInterpretations, plays, type PlayMediaItem, type PlayRow, type PlayStatus } from '@wsb/shared'

import type { PlaysConfig } from '../config'
import type { Db } from '../db'
import { log } from '../logger'
import type { MarketData } from '../market'
import { abortableSleep } from '../timing'
import { isUnbilledRejection, type PlayAnalyzer } from './analyzer'
import { buildPlayEvidence, deriveAnchor, derivePostedPnl, derivePrimaryTicker, deriveRealized } from './evidence'
import { preparePlayImages } from './images'
import { INTERPRET_SCHEMA_VERSION, TAXONOMY_VERSION, type PlayInterpretation } from './interpretation'
import { runMediaStage, type Fetcher, type MediaStageResult } from './media'
import { canDispatch, costUsd, estimateInputTokens, todaySpendUsd } from './metering'
import { validateExtraction, type PlayExtraction } from './validate'

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
/** Re-check delay when dispatch is refused (no usable price / daily budget hit) — NOT a fault: no
 *  attempts bump, the play just waits. Budget resets at UTC midnight; prices need a config change. */
const PARK_ON_REFUSAL_S = 900

export interface QueueDeps {
  /** The DEDICATED plays pool — never the radar's (invariant P9). */
  db: Db
  config: PlaysConfig
  /** The LLM seam (P2). Absent (no OPENAI_API_KEY) → the extraction stage is skipped: rows rest at
   *  media_ready, loudly, once per tick. */
  analyzer?: PlayAnalyzer
  /** Whitelist membership for the validation pass (product §4.1). Absent → everything that isn't a
   *  known non-equity is `unvalidated` (fail-conservative). */
  isListedTicker?: (ticker: string) => boolean
  /** Market provider for the evidence block (P3). Shared with the radar (stateless HTTP client);
   *  absent (--no-market / no creds) → market evidence degrades to "unavailable". */
  market?: MarketData | null
  /** The radar's window size ([window].seconds) — evidence bucketing only. Defaults to 3600. */
  windowSeconds?: number
  /** Injectable for tests. */
  clock?: () => number
  fetchImpl?: Fetcher
  media?: typeof runMediaStage
  /** Shutdown: stop claiming new rows; the in-flight row's fetches abort (cheap to redo). An LLM
   *  call in flight is awaited — its result is paid for; the loop just stops claiming more. */
  signal?: AbortSignal
}

export interface TickStats {
  claimed: number
  advanced: number // reached media_ready this tick (archived / degraded / text-only)
  retrying: number // transient media failure (still inside the retry window) or a shutdown release
  failed: number // stage crashes that hit max_attempts (terminal)
  extracted: number // media_ready → extracted this tick (P2)
  published: number // extracted → published this tick (P3: evidence + interpret + denormalize)
  parked: number // dispatch refusals (no price / budget) — waiting, not failing
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

/**
 * Claim up to `limit` due rows in `status`: not claimed (or lease-expired) and past
 * `next_attempt_at`. One short transaction — SELECT … FOR UPDATE SKIP LOCKED + the claim-stamp UPDATE —
 * so concurrent claimers (a second process, a stale-lease race) partition rows instead of blocking.
 * The returned rows carry the NEW `claimedAt`: it is this claimer's fence token — every later update
 * guards on it, so a claimer that lost its lease mid-stage can't clobber the re-claimer's work.
 */
export async function claimDue(
  db: Db, config: PlaysConfig, now: number, status: PlayStatus, limit: number,
): Promise<PlayRow[]> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(plays)
      .where(and(
        eq(plays.status, status),
        or(isNull(plays.nextAttemptAt), lte(plays.nextAttemptAt, now)),
        or(isNull(plays.claimedAt), lt(plays.claimedAt, now - config.leaseSeconds)),
      ))
      .orderBy(asc(plays.createdUtc), asc(plays.id))
      .limit(limit)
      .for('update', { skipLocked: true })
    if (rows.length) {
      await tx.update(plays).set({ claimedAt: now }).where(inArray(plays.id, rows.map((r) => r.id)))
    }
    return rows.map((r) => ({ ...r, claimedAt: now }))
  })
}

/** This claimer's WHERE fence: right row, still in the from-status, still OUR claim. The claim fence is
 *  what keeps a lease-expired straggler from mutating rows a re-claimer now owns; the status guard is
 *  the never-backwards rule (P8). A fenced-out update is a no-op — correct, and `warnIfFenced` makes it
 *  visible in logs and keeps it out of the tick stats. */
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

/** Advance a claimed `captured` row to `media_ready` with its final media verdict.
 *  Returns false when fenced out (nothing persisted — the row belongs to a re-claimer). */
async function advanceToMediaReady(
  db: Db, row: PlayRow, mediaStatus: 'archived' | 'failed' | 'none', items: PlayMediaItem[], now: number,
): Promise<boolean> {
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
  if (warnIfFenced(res, row, 'advance')) return false
  log.info({ playId: row.id, mediaStatus, images: items.length, isGallery: row.isGallery === true },
    'play advanced to media_ready')
  return true
}

/** Reschedule a transiently-failing media fetch inside its retry window (status stays `captured`).
 *  Any items archived THIS attempt are persisted so the next attempt reuses instead of re-fetching —
 *  and so an image deleted upstream between attempts is never lost from the manifest. */
async function scheduleMediaRetry(
  db: Db, row: PlayRow, retryUntil: number, items: PlayMediaItem[], now: number,
): Promise<boolean> {
  const res = await db.update(plays).set({
    mediaRetryUntil: retryUntil,
    nextAttemptAt: now + MEDIA_RETRY_INTERVAL_S,
    claimedAt: null,
    ...(items.length ? { media: items } : {}), // never clobber prior items with an empty attempt
  }).where(ownedBy(row))
  return !warnIfFenced(res, row, 'media-retry')
}

/** Release a shutdown-aborted claim UNCHANGED: not a fault (no attempts, no retry window), just due
 *  again on the next tick after restart. Advancing here would degrade the play to text-only over a
 *  plain deploy (P7); items archived before the abort are persisted for reuse. */
async function releaseClaim(db: Db, row: PlayRow, items: PlayMediaItem[], now: number): Promise<boolean> {
  const res = await db.update(plays).set({
    claimedAt: null,
    nextAttemptAt: now,
    ...(items.length ? { media: items } : {}),
  }).where(ownedBy(row))
  return !warnIfFenced(res, row, 'release')
}

/** Record a stage crash: bump `attempts`, back off exponentially, and only at `max_attempts` park the
 *  row as terminally `failed` — a single transient throw must not permanently kill a play.
 *  `terminal` reports what PERSISTED: a fenced-out update parked nothing. */
async function recordStageFailure(
  db: Db, row: PlayRow, config: PlaysConfig, now: number, err: unknown,
): Promise<{ terminal: boolean; fenced: boolean }> {
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
  const fenced = warnIfFenced(res, row, 'record-failure')
  return { terminal: terminal && !fenced, fenced }
}

/** The `captured` stage: resolve + archive media, then advance / retry / release / degrade (P7).
 *  `fenced` = the row's lease was lost mid-stage and a re-claimer owns it — nothing persisted here,
 *  so the tick must not count it as work done. */
async function processCaptured(deps: QueueDeps, row: PlayRow, now: number): Promise<'advanced' | 'retrying' | 'fenced'> {
  const media = deps.media ?? runMediaStage
  const r: MediaStageResult = await media(row, {
    config: deps.config, fetchImpl: deps.fetchImpl, signal: deps.signal,
  })

  if (r.aborted) {
    log.info({ playId: row.id, archived: r.items.length }, 'plays media stage aborted (shutdown) — releasing claim')
    return await releaseClaim(deps.db, row, r.items, now) ? 'retrying' : 'fenced'
  }
  if (r.none) {
    return await advanceToMediaReady(deps.db, row, 'none', [], now) ? 'advanced' : 'fenced'
  }
  if (r.retryable) {
    const retryUntil = row.mediaRetryUntil ?? now + deps.config.mediaRetrySeconds
    if (now < retryUntil) {
      log.warn({ playId: row.id, detail: r.detail, retryUntil }, 'plays media transient failure — will retry')
      return await scheduleMediaRetry(deps.db, row, retryUntil, r.items, now) ? 'retrying' : 'fenced'
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
  return await advanceToMediaReady(deps.db, row, status, items, now) ? 'advanced' : 'fenced'
}

/** Park a row on dispatch refusal: release the claim, come back later. NOT a fault — no attempts
 *  bump, no error. Budget refusals clear at UTC midnight; price refusals need a config change. */
async function parkForRefusal(db: Db, row: PlayRow, now: number): Promise<void> {
  const res = await db.update(plays).set({
    claimedAt: null,
    nextAttemptAt: now + PARK_ON_REFUSAL_S,
  }).where(ownedBy(row))
  warnIfFenced(res, row, 'park')
}

/**
 * The `media_ready` stage (P2): images + text → LLM extraction → deterministic validation →
 * `play_extractions` row + advance to `extracted`. Money moves here, so the order is deliberate
 * (tightened in review round 1):
 *
 *  1. **Dispatch gate FIRST** (invariant P6), before even image prep — a parked queue must not
 *     re-encode screenshots every re-check forever. The image count is estimable without prep.
 *  2. **The reservation is PERSISTED before the call**: the `play_extractions` row is inserted
 *     with the worst-case `cost_usd` up front and reconciled to real usage after. A crash (or
 *     SIGKILL) mid-call leaves the reservation row counted by `todaySpendUsd` — the cap
 *     over-counts instead of reopening, and a concurrent dispatcher sees the reservation too.
 *  3. **NO transaction spans the LLM call** (invariant P9); the reconcile and the advance are
 *     separate autocommit writes. A crash between them re-runs extraction: the unique
 *     `(play_id, run_at)` key keeps runs distinct and `current_extraction_at` names the winner.
 *  4. **Shutdown aborts the call** (the seam threads the signal); an abort releases the claim
 *     unchanged and DELETES the unreconciled reservation — the provider does not bill an aborted
 *     request, and keeping it would leak budget on every deploy.
 */
async function processMediaReady(
  deps: QueueDeps, analyzer: PlayAnalyzer, row: PlayRow, now: number,
): Promise<'extracted' | 'parked' | 'aborted' | 'fenced'> {
  const media = Array.isArray(row.media) ? (row.media as PlayMediaItem[]) : []
  const text = {
    title: row.title,
    selftext: row.selftext,
    flair: row.flair,
    // The expiry-year anchor (prompt v2): brokers show M/DD; the post date disambiguates the year.
    postedAt: row.createdUtc != null ? new Date(row.createdUtc * 1000).toISOString().slice(0, 10) : null,
  }
  const textChars = (row.title?.length ?? 0) + (row.selftext?.length ?? 0)
  const imageCountEstimate = Math.min(media.length, deps.config.maxImagesLlm)

  const decision = await canDispatch(
    deps.db, deps.config.llm, deps.config.llm.extractModel,
    estimateInputTokens(imageCountEstimate, textChars), now * 1000)
  if (!decision.ok) {
    log.warn({ playId: row.id, reason: decision.reason, detail: decision.detail },
      'plays extract dispatch REFUSED — parking the play (fail-closed metering, invariant P6)')
    await parkForRefusal(deps.db, row, now)
    return 'parked'
  }

  const prepared = media.length
    ? await preparePlayImages(row.id, media, {
      mediaDir: deps.config.mediaDir,
      maxImagesLlm: deps.config.maxImagesLlm,
      maxRequestBytes: deps.config.maxRequestBytes,
    })
    : { images: [], dropped: [], totalBytes: 0 }

  // Persist the reservation BEFORE the money moves (see step 2 above). `runAt` is REAL wall-clock
  // ms, not the logical queue clock: the unique `(play_id, run_at)` key must distinguish two runs
  // even when retries land inside the same logical second.
  const runAt = Date.now()
  const [reserved] = await deps.db.insert(playExtractions).values({
    playId: row.id,
    runAt,
    model: deps.config.llm.extractModel,
    promptVersion: null, // reconciled on success; a null-prompt row IS the crash marker
    output: null,
    tokensIn: null,
    tokensOut: null,
    costUsd: decision.reservedUsd,
  }).returning({ id: playExtractions.id })

  let result
  try {
    result = await analyzer.extract(prepared.images, text, { signal: deps.signal })
  } catch (e) {
    if (deps.signal?.aborted) {
      // Aborted before completion: not billed — drop the reservation, release the claim unchanged.
      await deps.db.delete(playExtractions).where(eq(playExtractions.id, reserved!.id))
      log.info({ playId: row.id }, 'plays extract aborted (shutdown) — releasing claim, reservation dropped')
      await releaseClaim(deps.db, row, [], now)
      return 'aborted'
    }
    if (isUnbilledRejection(e)) {
      // 401/403 = rejected BEFORE billing (bad key / missing scope): keep the meter honest by
      // dropping the reservation, then fail the stage normally (attempts/backoff still apply).
      await deps.db.delete(playExtractions).where(eq(playExtractions.id, reserved!.id))
    }
    throw e // a real provider/timeout failure keeps its reservation (fail-closed), stage crash path
  }

  const validated = validateExtraction(result.extraction, {
    isListedTicker: deps.isListedTicker ?? (() => false),
    mediaArchived: row.mediaStatus === 'archived' && prepared.images.length > 0,
  })
  const tokensIn = result.usage.inputTokens
  const tokensOut = result.usage.outputTokens
  // Reconcile real cost from usage; unreported usage keeps the reservation — the meter must never
  // undercount to $0 on a provider that omits usage (invariant P6).
  const cost = tokensIn != null && tokensOut != null
    ? costUsd(decision.prices, tokensIn, tokensOut)
    : decision.reservedUsd

  await deps.db.update(playExtractions).set({
    model: result.model,
    promptVersion: `${result.promptVersion}/${validated.schema_version}`,
    output: validated,
    tokensIn,
    tokensOut,
    costUsd: cost,
  }).where(eq(playExtractions.id, reserved!.id))

  const res = await deps.db.update(plays).set({
    status: 'extracted',
    currentExtractionAt: runAt,
    claimedAt: null,
    nextAttemptAt: now, // the P3 interpret stage is due immediately once it exists
    attempts: 0,
    error: null,
  }).where(ownedBy(row))
  if (warnIfFenced(res, row, 'extract-advance')) return 'fenced'
  log.info({
    playId: row.id, positions: validated.positions.length, direction: validated.direction,
    confidence: validated.confidence, screenshotKind: validated.screenshot_kind,
    images: prepared.images.length, tokensIn, tokensOut, costUsd: Number(cost.toFixed(5)),
  }, 'play extracted')
  return 'extracted'
}

/**
 * The `extracted` stage (P3, plays-plan §5): load the CURRENT extraction (by pointer, never
 * `max(run_at)`), assemble the deterministic evidence block, interpret via the seam, then publish —
 * the same money discipline as `processMediaReady` (gate first, reservation persisted before the
 * call, no tx across the LLM, abort drops the reservation), plus:
 *
 *  - **The evidence is INSERTED WITH the reservation row** — it is deterministic and it is what the
 *    prompt will see, so a crash mid-call leaves an auditable record of exactly what was sent
 *    (invariant P2); `prompt_version` stays null as the crash marker, same as extraction.
 *  - **The herd gate is decided HERE, from the evidence** (invariant P4): `allowHerd` shapes the
 *    category enum inside the seam; the model never sees `herd-following` below threshold.
 *  - **Publish is ONE row update** (plan §5): status/`published_at`/pointer/denormalized board
 *    fields together — a reader can never observe a published play with half its board fields.
 */
async function processExtracted(
  deps: QueueDeps, analyzer: PlayAnalyzer, row: PlayRow, now: number,
): Promise<'published' | 'parked' | 'aborted' | 'fenced'> {
  if (row.currentExtractionAt == null) {
    throw new Error('extracted play has no current_extraction_at pointer — cannot interpret (P8 violation upstream?)')
  }
  const [extRow] = await deps.db.select().from(playExtractions).where(and(
    eq(playExtractions.playId, row.id), eq(playExtractions.runAt, row.currentExtractionAt)))
  const extraction = extRow?.output as PlayExtraction | null | undefined
  if (extraction == null || !Array.isArray(extraction.positions)) {
    throw new Error(`current extraction row (run_at ${row.currentExtractionAt}) missing or outputless`)
  }

  // Evidence: deterministic DB/market reads, no LLM — cheap enough to rebuild on every retry.
  const evidence = await buildPlayEvidence({
    db: deps.db, market: deps.market, flairs: deps.config.flairs,
    herdLookbackHours: deps.config.herd.lookbackHours, herdMinAuthors: deps.config.herd.minAuthors,
    heatStalenessSeconds: deps.config.heatStalenessSeconds,
    windowSeconds: deps.windowSeconds ?? 3600,
  }, { id: row.id, author: row.author, createdUtc: row.createdUtc ?? now }, extraction)
  const allowHerd = evidence.herd?.eligible === true

  const text = {
    title: row.title, selftext: row.selftext, flair: row.flair,
    postedAt: row.createdUtc != null ? new Date(row.createdUtc * 1000).toISOString().slice(0, 10) : null,
  }
  // The real payload is text-only: post text + the two serialized JSON blocks.
  const textChars = (row.title?.length ?? 0) + (row.selftext?.length ?? 0)
    + JSON.stringify(extraction).length + JSON.stringify(evidence).length
  const decision = await canDispatch(
    deps.db, deps.config.llm, deps.config.llm.interpretModel,
    estimateInputTokens(0, textChars), now * 1000)
  if (!decision.ok) {
    log.warn({ playId: row.id, reason: decision.reason, detail: decision.detail },
      'plays interpret dispatch REFUSED — parking the play (fail-closed metering, invariant P6)')
    await parkForRefusal(deps.db, row, now)
    return 'parked'
  }

  const runAt = Date.now() // real wall-clock ms — the unique (play_id, run_at) key (same as extract)
  const [reserved] = await deps.db.insert(playInterpretations).values({
    playId: row.id,
    runAt,
    model: deps.config.llm.interpretModel,
    promptVersion: null, // reconciled on success; a null-prompt row IS the crash marker
    evidence, // stored at reservation time — deterministic, and exactly what the prompt sees (P2)
    output: null,
    tokensIn: null,
    tokensOut: null,
    costUsd: decision.reservedUsd,
  }).returning({ id: playInterpretations.id })

  let result
  try {
    result = await analyzer.interpret({ text, extraction, evidence, allowHerd }, { signal: deps.signal })
  } catch (e) {
    if (deps.signal?.aborted) {
      await deps.db.delete(playInterpretations).where(eq(playInterpretations.id, reserved!.id))
      log.info({ playId: row.id }, 'plays interpret aborted (shutdown) — releasing claim, reservation dropped')
      await releaseClaim(deps.db, row, [], now)
      return 'aborted'
    }
    if (isUnbilledRejection(e)) {
      await deps.db.delete(playInterpretations).where(eq(playInterpretations.id, reserved!.id))
    }
    throw e // real provider failure keeps its reservation (fail-closed), stage crash path
  }

  const output: PlayInterpretation = {
    schema_version: INTERPRET_SCHEMA_VERSION,
    taxonomy_version: TAXONOMY_VERSION,
    herd_allowed: allowHerd,
    ...result.interpretation,
  }
  const tokensIn = result.usage.inputTokens
  const tokensOut = result.usage.outputTokens
  const cost = tokensIn != null && tokensOut != null
    ? costUsd(decision.prices, tokensIn, tokensOut)
    : decision.reservedUsd

  await deps.db.update(playInterpretations).set({
    model: result.model,
    promptVersion: `${result.promptVersion}/${INTERPRET_SCHEMA_VERSION}`,
    output,
    tokensIn,
    tokensOut,
    costUsd: cost,
  }).where(eq(playInterpretations.id, reserved!.id))

  // THE publish update (plan §5) — board denormalization + published_at + the current-run pointers
  // + status, one atomic row write. Posted P&L is what the screenshot showed; P5 marks never
  // overwrite these fields.
  const { pnlAbs, pnlPct } = derivePostedPnl(extraction.positions)
  const res = await deps.db.update(plays).set({
    status: 'published',
    publishedAt: now,
    currentInterpretationAt: runAt,
    primaryTicker: derivePrimaryTicker(extraction.positions),
    category: output.category,
    tags: output.tags,
    // The board confidence is the extraction's DERIVED one (validate.ts) — evidence-grounded;
    // the interpretation's self-report stays inside the output jsonb for calibration.
    confidence: extraction.confidence,
    pnlAbs,
    pnlPct,
    realized: deriveRealized(extraction.positions),
    summary: output.summary,
    tldr: output.tldr,
    extractorVersion: extRow!.promptVersion,
    interpreterVersion: `${result.promptVersion}/${INTERPRET_SCHEMA_VERSION}`,
    taxonomyVersion: TAXONOMY_VERSION,
    claimedAt: null,
    nextAttemptAt: null,
    attempts: 0,
    error: null,
  }).where(ownedBy(row))
  if (warnIfFenced(res, row, 'publish')) return 'fenced'
  log.info({
    playId: row.id, ticker: derivePrimaryTicker(extraction.positions), category: output.category,
    tags: output.tags, allowHerd, herdAuthors: evidence.herd?.distinct_authors ?? null,
    anchorBasis: evidence.anchor_basis, tokensIn, tokensOut, costUsd: Number(cost.toFixed(5)),
  }, 'play published')
  return 'published'
}

/** Due backlog at a status — the queue-depth signal the tick logs for the LLM stages (P2/P3). */
async function stageDepth(db: Db, status: PlayStatus, now: number): Promise<number> {
  const [row] = await db.select({ n: count() }).from(plays)
    .where(and(eq(plays.status, status), or(isNull(plays.nextAttemptAt), lte(plays.nextAttemptAt, now))))
  return row?.n ?? 0
}

/** One queue tick: claim due rows per stage, run each row with a per-row exception boundary. */
export async function runQueueTick(deps: QueueDeps): Promise<TickStats> {
  const clock = deps.clock ?? nowSeconds
  const stats: TickStats = { claimed: 0, advanced: 0, retrying: 0, failed: 0, extracted: 0, published: 0, parked: 0 }

  const captured = await claimDue(deps.db, deps.config, clock(), 'captured', CLAIM_BATCH)
  stats.claimed += captured.length
  for (const row of captured) {
    if (deps.signal?.aborted) break // drain: stop starting rows; unprocessed claims lapse via the lease
    try {
      const outcome = await processCaptured(deps, row, clock())
      if (outcome === 'advanced') stats.advanced++
      else if (outcome === 'retrying') stats.retrying++
      // 'fenced': counted only in `claimed` — the row's real outcome belongs to whoever re-claimed it.
    } catch (e) {
      const { terminal, fenced } = await recordStageFailure(deps.db, row, deps.config, clock(), e)
      if (terminal) stats.failed++
      log.error(
        { playId: row.id, err: String(e), attempts: (row.attempts ?? 0) + 1, terminal, ...(fenced ? { fenced } : {}) },
        'plays stage crashed')
    }
  }

  // P2/P3: the LLM stages, only with a wired analyzer (no credentials → rows rest, loudly).
  if (deps.analyzer && !deps.signal?.aborted) {
    let llmWork = 0
    // DOWNSTREAM FIRST: interpret the already-extracted backlog before extracting more. The other
    // order would run a fresh extraction's interpret in the SAME tick (extract sets the row due
    // immediately) — two LLM calls per play per tick, so `max_plays_per_tick` would bound half of
    // what its name says, and a budget-refusal mid-pipeline would land unevenly.
    for (const [status, process] of [
      ['extracted', processExtracted] as const, // → published (P3)
      ['media_ready', processMediaReady] as const, // → extracted (P2)
    ]) {
      if (deps.signal?.aborted) break
      const batch = await claimDue(
        deps.db, deps.config, clock(), status, Math.min(CLAIM_BATCH, deps.config.llm.maxPlaysPerTick))
      stats.claimed += batch.length
      llmWork += batch.length
      for (const row of batch) {
        if (deps.signal?.aborted) {
          await releaseClaim(deps.db, row, [], clock())
          stats.retrying++
          continue
        }
        try {
          const outcome = await process(deps, deps.analyzer, row, clock())
          if (outcome === 'extracted') stats.extracted++
          else if (outcome === 'published') stats.published++
          else if (outcome === 'parked') stats.parked++
          else if (outcome === 'aborted') stats.retrying++
        } catch (e) {
          const { terminal, fenced } = await recordStageFailure(deps.db, row, deps.config, clock(), e)
          if (terminal) stats.failed++
          log.error(
            { playId: row.id, err: String(e), attempts: (row.attempts ?? 0) + 1, terminal, ...(fenced ? { fenced } : {}) },
            'plays stage crashed')
        }
      }
    }
    if (llmWork > 0) {
      // The LLM-stage ops signal: realized UTC-day spend + what's still waiting (plays-plan §4).
      const [spent, mediaDepth, extractedDepth] = await Promise.all([
        todaySpendUsd(deps.db, clock() * 1000),
        stageDepth(deps.db, 'media_ready', clock()), stageDepth(deps.db, 'extracted', clock()),
      ])
      log.info({ spendTodayUsd: Number(spent.toFixed(4)), mediaReadyDepth: mediaDepth, extractedDepth },
        'plays llm spend')
    }
  } else if (!deps.analyzer) {
    const depth = await stageDepth(deps.db, 'media_ready', clock())
    if (depth > 0) log.warn({ queued: depth }, 'plays extraction OFF (no analyzer — set OPENAI_API_KEY); media_ready backlog waiting')
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
