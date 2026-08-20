/**
 * Plays read paths + response contracts: the `/plays` card list and the `/plays/:id` detail.
 *
 * P1 built the bare list; P3's publish denormalizes the board fields onto the play row
 * (ticker/category/P&L/tldr…), which the card now carries — NULL until the play is published. The
 * detail read joins the extraction/interpretation child rows BY the play's current-run pointers,
 * never `max(run_at)` (plays-plan §5 — a reprocess that dies between child-insert and row-update
 * must not mix runs). Child `output`/`evidence` jsonb are WORKER-owned shapes (extraction.ts /
 * interpretation.ts / evidence.ts): parsed here with LENIENT schemas — `.catch()` fallbacks
 * throughout — so a version drift degrades a section to null/'—' instead of 503ing the page.
 * P4 proper grows filters/sorts around this read.
 */
import { and, desc, eq, ne, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'

import { playExtractions, playInterpretations, plays, type PlayMediaItem } from '@wsb/shared'

export const PlayCardSchema = z.object({
  id: z.string(),
  createdUtc: z.number().nullable(),
  capturedAt: z.number().nullable(),
  publishedAt: z.number().nullable(),
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
  // Denormalized board fields (P3 publish) — all null until status is `published`.
  primaryTicker: z.string().nullable(),
  category: z.string().nullable(),
  confidence: z.number().nullable(),
  pnlAbs: z.number().nullable(),
  pnlPct: z.number().nullable(),
  realized: z.boolean().nullable(),
  tldr: z.string().nullable(),
})

export const PlaysResponseSchema = z.object({
  plays: z.array(PlayCardSchema),
})

export type PlayCard = z.infer<typeof PlayCardSchema>
export type PlaysResponse = z.infer<typeof PlaysResponseSchema>

// --- detail contract --------------------------------------------------------------------------------

/** One extracted leg (worker validate.ts `ValidatedPosition`), lenient: any field the worker adds,
 *  renames, or mistypes degrades to null — the row renders '—', the page survives. */
const PositionSchema = z.object({
  position_id: z.string().catch(''),
  ticker: z.string().catch('?'),
  instrument: z.string().catch('other'),
  side: z.string().nullable().catch(null),
  quantity: z.number().nullable().catch(null),
  avg_price: z.number().nullable().catch(null),
  strike: z.number().nullable().catch(null),
  expiry: z.string().nullable().catch(null),
  cost_basis: z.number().nullable().catch(null),
  current_value: z.number().nullable().catch(null),
  pnl_abs: z.number().nullable().catch(null),
  pnl_pct: z.number().nullable().catch(null),
  realized: z.boolean().nullable().catch(null),
  opened_at: z.string().nullable().catch(null),
  currency: z.string().nullable().catch(null),
  ticker_outcome: z.string().nullable().catch(null),
  arithmetic_ok: z.boolean().nullable().catch(null),
})

/** Worker validate.ts `PlayExtraction` (the persisted extraction output), lenient. */
const ExtractionOutputSchema = z.object({
  screenshot_kind: z.string().nullable().catch(null),
  broker: z.string().nullable().catch(null),
  positions: z.array(PositionSchema).catch([]),
  notes: z.string().nullable().catch(null),
  direction: z.string().nullable().catch(null),
  confidence: z.number().nullable().catch(null),
}).nullable().catch(null)

/** Worker interpretation.ts `PlayInterpretation`, lenient. */
const InterpretationOutputSchema = z.object({
  thesis: z.string().nullable().catch(null),
  outcome: z.string().nullable().catch(null),
  context: z.string().nullable().catch(null),
  category: z.string().nullable().catch(null),
  tags: z.array(z.string()).catch([]),
  summary: z.string().nullable().catch(null),
  tldr: z.string().nullable().catch(null),
  herd_allowed: z.boolean().nullable().catch(null),
}).nullable().catch(null)

/** Worker evidence.ts `PlayEvidence` — the stored block the interpret prompt saw (invariant P2:
 *  every published label traceable to it). Lenient for the same drift reason. */
const EvidenceSchema = z.object({
  ticker: z.string().nullable().catch(null),
  ticker_outcome: z.string().nullable().catch(null),
  direction: z.string().nullable().catch(null),
  anchor_utc: z.number().nullable().catch(null),
  anchor_basis: z.string().nullable().catch(null),
  post_utc: z.number().nullable().catch(null),
  radar: z.object({
    window_start: z.number().nullable().catch(null),
    heat: z.object({
      rank: z.number().nullable().catch(null),
      sov: z.number().nullable().catch(null),
      h_e: z.number().nullable().catch(null),
      mentions: z.number().nullable().catch(null),
      authors: z.number().nullable().catch(null),
    }).nullable().catch(null),
    mentions_24h: z.number().nullable().catch(null),
    authors_24h: z.number().nullable().catch(null),
    mentions_72h: z.number().nullable().catch(null),
    authors_72h: z.number().nullable().catch(null),
    note: z.string().nullable().catch(null),
  }).nullable().catch(null),
  herd: z.object({
    direction: z.string().nullable().catch(null),
    distinct_authors: z.number().nullable().catch(null),
    threshold: z.number().nullable().catch(null),
    lookback_hours: z.number().nullable().catch(null),
    eligible: z.boolean().nullable().catch(null),
  }).nullable().catch(null),
  market: z.object({
    as_of: z.number().nullable().catch(null),
    day_ret: z.number().nullable().catch(null),
    five_day_ret: z.number().nullable().catch(null),
    rvol: z.number().nullable().catch(null),
    rvol_conf: z.string().nullable().catch(null),
    movers: z.array(z.string()).catch([]),
    note: z.string().nullable().catch(null),
  }).nullable().catch(null),
  note: z.string().nullable().catch(null),
}).nullable().catch(null)

/** One current LLM run (extraction or interpretation) as served: provenance + parsed payloads. */
const RunSchema = z.object({
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  runAt: z.number(), // MILLISECONDS (schema convention for run_at)
})

export const PlayDetailSchema = z.object({
  play: PlayCardSchema.extend({
    selftext: z.string().nullable(),
    url: z.string().nullable(),
    score: z.number().nullable(),
    numComments: z.number().nullable(),
    removed: z.boolean().nullable(),
    tags: z.array(z.string()),
    summary: z.string().nullable(),
    extractorVersion: z.string().nullable(),
    interpreterVersion: z.string().nullable(),
    taxonomyVersion: z.string().nullable(),
    trackStatus: z.string().nullable(),
    /** ALL archived images in gallery order (the card only carries the first). */
    images: z.array(z.object({ path: z.string(), order: z.number().nullable() })),
  }),
  extraction: RunSchema.extend({ output: ExtractionOutputSchema }).nullable(),
  interpretation: RunSchema.extend({
    output: InterpretationOutputSchema,
    evidence: EvidenceSchema,
  }).nullable(),
})

export type PlayDetail = z.infer<typeof PlayDetailSchema>

const LIST_LIMIT = 200

const toCard = (r: {
  id: string, createdUtc: number | null, capturedAt: number | null, publishedAt: number | null,
  author: string | null, flair: string | null, title: string | null, permalink: string | null,
  status: string, mediaStatus: string | null, isGallery: boolean | null, media: unknown,
  primaryTicker: string | null, category: string | null, confidence: number | null,
  pnlAbs: number | null, pnlPct: number | null, realized: boolean | null, tldr: string | null,
}): PlayCard => {
  const media = Array.isArray(r.media) ? (r.media as PlayMediaItem[]) : []
  return {
    id: r.id, createdUtc: r.createdUtc, capturedAt: r.capturedAt, publishedAt: r.publishedAt,
    author: r.author, flair: r.flair, title: r.title, permalink: r.permalink, status: r.status,
    mediaStatus: r.mediaStatus, isGallery: r.isGallery,
    imageCount: media.length,
    thumb: media[0]?.path ?? null,
    primaryTicker: r.primaryTicker, category: r.category, confidence: r.confidence,
    pnlAbs: r.pnlAbs, pnlPct: r.pnlPct, realized: r.realized, tldr: r.tldr,
  }
}

const cardColumns = {
  id: plays.id, createdUtc: plays.createdUtc, capturedAt: plays.capturedAt,
  publishedAt: plays.publishedAt, author: plays.author, flair: plays.flair, title: plays.title,
  permalink: plays.permalink, status: plays.status, mediaStatus: plays.mediaStatus,
  isGallery: plays.isGallery, media: plays.media, primaryTicker: plays.primaryTicker,
  category: plays.category, confidence: plays.confidence, pnlAbs: plays.pnlAbs,
  pnlPct: plays.pnlPct, realized: plays.realized, tldr: plays.tldr,
}

/** Newest captured plays (single ORDER BY-stable read; no cycle coupling — plays publish row-by-row).
 *  Tombstoned rows (`discarded`: removed posts, zero-position extractions) are excluded — they exist
 *  only so poll re-delivery can't re-insert them, not for display. */
export async function readPlays(db: NodePgDatabase): Promise<PlayCard[]> {
  const rows = await db.select(cardColumns).from(plays)
    .where(ne(plays.status, 'discarded'))
    // NULLS LAST: Postgres DESC sorts NULLs first, and capture null-fills a junk created_utc — those
    // rows belong at the bottom, not pinned above every real play.
    .orderBy(sql`${plays.createdUtc} desc nulls last`, desc(plays.id))
    .limit(LIST_LIMIT)

  return rows.map(toCard)
}

/** One play + its CURRENT extraction/interpretation runs (by pointer). Null = no such play. */
export async function readPlayDetail(db: NodePgDatabase, id: string): Promise<PlayDetail | null> {
  const [row] = await db.select().from(plays).where(eq(plays.id, id)).limit(1)
  if (!row) return null

  const media = Array.isArray(row.media) ? (row.media as PlayMediaItem[]) : []

  let extraction: PlayDetail['extraction'] = null
  if (row.currentExtractionAt != null) {
    const [ex] = await db.select({
      model: playExtractions.model, promptVersion: playExtractions.promptVersion,
      runAt: playExtractions.runAt, output: playExtractions.output,
    }).from(playExtractions)
      .where(and(eq(playExtractions.playId, id), eq(playExtractions.runAt, row.currentExtractionAt)))
      .limit(1)
    // A pointer with no matching child (partial reprocess crash) serves as "no extraction" —
    // never fall back to another run.
    if (ex) {
      extraction = {
        model: ex.model, promptVersion: ex.promptVersion, runAt: ex.runAt,
        output: ExtractionOutputSchema.parse(ex.output),
      }
    }
  }

  let interpretation: PlayDetail['interpretation'] = null
  if (row.currentInterpretationAt != null) {
    const [it] = await db.select({
      model: playInterpretations.model, promptVersion: playInterpretations.promptVersion,
      runAt: playInterpretations.runAt, output: playInterpretations.output,
      evidence: playInterpretations.evidence,
    }).from(playInterpretations)
      .where(and(eq(playInterpretations.playId, id), eq(playInterpretations.runAt, row.currentInterpretationAt)))
      .limit(1)
    if (it) {
      interpretation = {
        model: it.model, promptVersion: it.promptVersion, runAt: it.runAt,
        output: InterpretationOutputSchema.parse(it.output),
        evidence: EvidenceSchema.parse(it.evidence),
      }
    }
  }

  return {
    play: {
      ...toCard(row),
      selftext: row.selftext, url: row.url, score: row.score, numComments: row.numComments,
      removed: row.removed,
      tags: Array.isArray(row.tags) ? (row.tags as unknown[]).filter((t): t is string => typeof t === 'string') : [],
      summary: row.summary, extractorVersion: row.extractorVersion,
      interpreterVersion: row.interpreterVersion, taxonomyVersion: row.taxonomyVersion,
      trackStatus: row.trackStatus,
      images: media.map((m) => ({ path: m.path, order: m.order ?? null })),
    },
    extraction,
    interpretation,
  }
}
