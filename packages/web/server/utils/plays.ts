/**
 * The plays list read + response contract (P1 — plays-plan §3's bare `/plays` list). Deliberately
 * minimal: captured rows with thumbnails, newest first, proving capture → media volume → web end-to-end
 * before any LLM money is spent. P4 grows the real board (filters, detail pages) around it.
 */
import { desc, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'

import { plays, type PlayMediaItem } from '@wsb/shared'

export const PlayCardSchema = z.object({
  id: z.string(),
  createdUtc: z.number().nullable(),
  capturedAt: z.number().nullable(),
  author: z.string().nullable(),
  flair: z.string().nullable(),
  title: z.string().nullable(),
  permalink: z.string().nullable(),
  status: z.string(),
  mediaStatus: z.string().nullable(),
  isGallery: z.boolean().nullable(),
  imageCount: z.number().int(),
  /** Relative media path of the first archived image (`<post_id>/0.<ext>`) — the card thumbnail,
   *  served via `/api/media/<thumb>`. Null for text-only / degraded plays. */
  thumb: z.string().nullable(),
})

export const PlaysResponseSchema = z.object({
  plays: z.array(PlayCardSchema),
})

export type PlayCard = z.infer<typeof PlayCardSchema>
export type PlaysResponse = z.infer<typeof PlaysResponseSchema>

const LIST_LIMIT = 200

/** Newest captured plays (single ORDER BY-stable read; no cycle coupling — plays publish row-by-row). */
export async function readPlays(db: NodePgDatabase): Promise<PlayCard[]> {
  const rows = await db.select({
    id: plays.id, createdUtc: plays.createdUtc, capturedAt: plays.capturedAt, author: plays.author,
    flair: plays.flair, title: plays.title, permalink: plays.permalink, status: plays.status,
    mediaStatus: plays.mediaStatus, isGallery: plays.isGallery, media: plays.media,
  }).from(plays)
    // NULLS LAST: Postgres DESC sorts NULLs first, and capture null-fills a junk created_utc — those
    // rows belong at the bottom, not pinned above every real play.
    .orderBy(sql`${plays.createdUtc} desc nulls last`, desc(plays.id))
    .limit(LIST_LIMIT)

  return rows.map((r) => {
    const media = Array.isArray(r.media) ? (r.media as PlayMediaItem[]) : []
    return {
      id: r.id, createdUtc: r.createdUtc, capturedAt: r.capturedAt, author: r.author, flair: r.flair,
      title: r.title, permalink: r.permalink, status: r.status, mediaStatus: r.mediaStatus,
      isGallery: r.isGallery,
      imageCount: media.length,
      thumb: media[0]?.path ?? null,
    }
  })
}
