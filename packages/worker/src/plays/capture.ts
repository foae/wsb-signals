/**
 * Plays capture (P1, plays-plan §3) — turn the poll's flair-matched raw posts into `plays` rows.
 *
 * The load-bearing rules, all consequences of the radar invariants + P8:
 *  - The flair filter lives HERE, not in `Source.poll()` — the ingest seam stays plays-agnostic.
 *  - The insert is `ON CONFLICT DO NOTHING` — the 5-min poll re-delivers every candidate ~12×, and the
 *    radar's `onConflictDoUpdate` house style would reset `status` and re-enqueue (re-charge) each play
 *    12×/hour. No writer ever moves `status` backwards (invariant P8).
 *  - The caller runs this OUTSIDE every radar transaction, after `publishCycle` commits, and best-effort:
 *    `capturePlays` never throws — a plays-table error must not kill the radar cycle (invariant P1).
 */
import { plays, type PlayInsert, type PlayMediaStatus } from '@wsb/shared'

import type { PlaysConfig } from '../config'
import type { Db } from '../db'
import { isRemovedText, type RawThing } from '../ingest'
import { log } from '../logger'

/** Direct-download image host — a bare `url` pointing here is the single-image shape (product §3). */
const DIRECT_IMAGE_RE = /^https?:\/\/i\.redd\.it\/[\w-]+\.(?:jpe?g|png|webp|gif)$/i

/** Reddit post ids are short base36; anything else is a corrupt/hostile upstream dict. The id becomes a
 *  FILESYSTEM PATH SEGMENT (media dir) and a URL segment (web media route) — a path-capable id must be
 *  rejected at this single choke point, not sanitized downstream. */
const PLAY_ID_RE = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Classify the post's media shape at capture time (product §3): anything the media resolver can try
 * (`pending`) vs a genuinely text-only post (`none`). The resolver re-derives the details from `raw`;
 * this only decides whether there is media work to do at all.
 */
export function initialMediaStatus(d: RawThing): Extract<PlayMediaStatus, 'pending' | 'none'> {
  if (d.is_gallery === true) return 'pending'
  if (typeof d.url === 'string' && DIRECT_IMAGE_RE.test(d.url)) return 'pending'
  // Inline self-post images: media_metadata present (non-null object) on a text post. Galleries also
  // carry media_metadata (P1 gate finding — Arctic-Shift archives it for fresh posts), but they're
  // caught by is_gallery above; the resolver handles both shapes.
  const mm = d.media_metadata
  if (mm != null && typeof mm === 'object' && Object.keys(mm).length > 0) return 'pending'
  return 'none'
}

/** Removal markers visible in the raw dict: a mod-removed/author-deleted post has no analyzable
 *  content ("[removed]" body, dead media) — capturing it burns media fetches + LLM calls on nothing.
 *  Paired with the capture delay so fast-moderated junk never enters the queue at all. */
export function isRemovedPost(d: RawThing): boolean {
  if (isRemovedText(d.title, d.selftext)) return true
  return typeof d.removed_by_category === 'string' && d.removed_by_category.length > 0
}

/** The flair-matched subset of a poll's raw posts, mapped to insertable rows (status `captured`).
 *  Posts without a well-formed id are dropped — an unidentifiable play can't be deduped or linked,
 *  and the id must be path-safe (PLAY_ID_RE). Posts younger than `captureDelaySeconds` are DEFERRED
 *  (not returned; the poll re-delivers them ~12×/h and they enqueue once old enough) so moderation
 *  has time to act first; posts already removed are SKIPPED (isRemovedPost); text-only posts with
 *  less than `textOnlyMinChars` of selftext are SKIPPED as thin (a bare title can't yield positions
 *  — nothing for the LLM). Null `created_utc` can't prove age — captured anyway rather than
 *  deferred forever. */
export function playRowsFromRaw(
  rawPosts: readonly RawThing[], flairs: ReadonlySet<string>, now: number,
  captureDelaySeconds: number, textOnlyMinChars: number,
): { rows: PlayInsert[]; deferred: number; removed: number; thin: number } {
  const out: PlayInsert[] = []
  let deferred = 0
  let removed = 0
  let thin = 0
  for (const d of rawPosts) {
    const flair = typeof d.link_flair_text === 'string' ? d.link_flair_text : null
    if (flair == null || !flairs.has(flair)) continue
    if (isRemovedPost(d)) {
      removed++
      continue
    }
    const created = typeof d.created_utc === 'number' ? Math.trunc(d.created_utc) : null
    if (created != null && created > now - captureDelaySeconds) {
      deferred++
      continue
    }
    // Thin gate only for genuinely media-less posts — a post whose media later FAILS still proceeds
    // text-only (a fetch failure is not a content judgment, invariant P7).
    if (initialMediaStatus(d) === 'none') {
      const text = typeof d.selftext === 'string' ? d.selftext.trim() : ''
      if (text.length < textOnlyMinChars) {
        thin++
        continue
      }
    }
    if (typeof d.id !== 'string' || !PLAY_ID_RE.test(d.id)) {
      // Anomalous, not routine: a flair-MATCHED post is being dropped. Silent, this looks like a
      // mysteriously missing play; logged, it names the culprit. The poll re-delivers ~12×/h, so a
      // bad post re-warns each sighting — deliberate: the anomaly is near-never and must stay loud.
      log.warn({ id: String(d.id).slice(0, 40), flair }, 'plays capture: dropping matched post with unusable id')
      continue
    }
    out.push({
      id: d.id,
      createdUtc: typeof d.created_utc === 'number' ? Math.trunc(d.created_utc) : null,
      capturedAt: now,
      author: typeof d.author === 'string' ? d.author : null,
      flair,
      title: typeof d.title === 'string' ? d.title : null,
      selftext: typeof d.selftext === 'string' ? d.selftext : null,
      permalink: typeof d.permalink === 'string' ? d.permalink : null,
      url: typeof d.url === 'string' ? d.url : null,
      isGallery: d.is_gallery === true,
      mediaStatus: initialMediaStatus(d),
      raw: d, // full Arctic-Shift dict — provenance + reprocessing input (plays-plan §3)
      // Archive-time engagement is ~0/1 (untrustworthy until ~36h); the P5 refresh pass updates it.
      score: typeof d.score === 'number' ? Math.trunc(d.score) : null,
      numComments: typeof d.num_comments === 'number' ? Math.trunc(d.num_comments) : null,
      status: 'captured',
      attempts: 0,
      nextAttemptAt: now, // due immediately — the queue's next tick picks it up
    })
  }
  return { rows: out, deferred, removed, thin }
}

export interface CaptureStats {
  /** Raw posts the poll delivered (the flair-rename canary: matched+deferred+removed all 0 with
   *  seen>0 for a day ⇒ check `plays.flairs` against the sub — plays-plan §11). */
  seen: number
  matched: number
  inserted: number
  /** Galleries among the matched set — the P1 gate measures gallery prevalence (plays-plan §3). */
  galleries: number
  /** Flair-matched but younger than the capture delay — will enqueue on a later poll. */
  deferred: number
  /** Flair-matched but already removed/deleted upstream — never enqueued. */
  removed: number
  /** Flair-matched text-only posts under `text_only_min_chars` — nothing for the LLM, never enqueued. */
  thin: number
}

/**
 * Best-effort capture: insert the flair-matched plays, ON CONFLICT DO NOTHING. Never throws — errors
 * are logged and swallowed so the radar cycle publishes regardless (invariant P1). Uses the dedicated
 * plays pool, keeping even this insert off the radar's connections (invariant P9's spirit).
 */
export async function capturePlays(
  db: Db, rawPosts: readonly RawThing[], config: PlaysConfig, now: number,
): Promise<CaptureStats> {
  const { rows, deferred, removed, thin } = playRowsFromRaw(
    rawPosts, config.flairs, now, config.captureDelaySeconds, config.textOnlyMinChars)
  const stats: CaptureStats = {
    seen: rawPosts.length,
    matched: rows.length,
    inserted: 0,
    galleries: rows.filter((r) => r.isGallery).length,
    deferred,
    removed,
    thin,
  }
  try {
    let insertedIds: string[] = []
    if (rows.length > 0) {
      // ~35 posts/cycle — far under the bind-parameter chunking threshold; one statement.
      const inserted = await db.insert(plays).values(rows)
        .onConflictDoNothing({ target: plays.id })
        .returning({ id: plays.id })
      stats.inserted = inserted.length
      insertedIds = inserted.map((r) => r.id)
    }
    // Logged EVERY cycle, including matched=0 — that silent case IS the flair-rename canary; gating the
    // log on inserted>0 would mute it exactly when the flair list breaks. New ids are named so a play
    // can be traced through the logs from this line to its `media_ready` line.
    log.info({ ...stats, ...(insertedIds.length ? { ids: insertedIds } : {}) }, 'plays capture')
  } catch (e) {
    log.error({ err: String(e) }, 'plays capture insert failed — radar cycle unaffected, will retry next poll')
  }
  return stats
}
