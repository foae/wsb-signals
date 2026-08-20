/**
 * WSB Plays — cross-package enums + the `plays.media` jsonb shape (plays-plan §3). Shared because the
 * worker writes them and the web reads them; the string values are persisted, so changing one is a
 * data migration, not a rename.
 */

/** Queue statuses, in pipeline order. `failed` is terminal and only reachable after `max_attempts`
 *  transient failures (plays-plan §3); no writer ever moves `status` backwards (invariant P8).
 *  There is deliberately no status between `extracted` and `published`: plan §5 pins the publish
 *  (denormalize + published_at + pointers) into the interpret stage's ONE advance update. */
export const PLAY_STATUSES = ['captured', 'media_ready', 'extracted', 'published', 'failed'] as const
export type PlayStatus = (typeof PLAY_STATUSES)[number]

/**
 * Media state — deliberately SEPARATE from the queue status (a media failure degrades the play to
 * text-only analysis, it never parks or fails it — invariant P7):
 *  - `pending`  — the post has media the resolver hasn't archived yet;
 *  - `archived` — ≥1 image archived to the media volume (`media` jsonb lists them);
 *  - `failed`   — had media but nothing could be archived (deleted / 403 / retry window exhausted) —
 *                 the play proceeds text-only with lowered confidence;
 *  - `none`     — a text-only post; there was never media to fetch.
 */
export const PLAY_MEDIA_STATUSES = ['pending', 'archived', 'failed', 'none'] as const
export type PlayMediaStatus = (typeof PLAY_MEDIA_STATUSES)[number]

/** One archived image in the `plays.media` jsonb array, in gallery order (order 0 is nearly always the
 *  position screenshot — plays-plan §3). `path` is RELATIVE to the media root (`<post_id>/<n>.<ext>`)
 *  so the worker (writer) and web (reader) can mount the volume at different absolute paths. */
export interface PlayMediaItem {
  order: number
  path: string
  ext: string
  bytes: number
  sha256: string
  sourceUrl: string
}
