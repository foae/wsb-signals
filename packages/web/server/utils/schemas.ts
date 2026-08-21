/**
 * Zod schemas + inferred types for the `/api/board` response (slice 8). The schema is the single source
 * of truth for the API contract: the server validates its assembled payload before returning (catching
 * any schema/read drift), and the client imports the inferred types.
 */
import { z } from 'zod'

/** Attention×Action quadrant (analytics.ts `Quadrant`). Unknown/missing → null so one bad value can't
 *  503 the whole board — but LOG it server-side so a worker regression writing a junk quadrant is visible
 *  (not silently swallowed). */
export const QuadrantSchema = z.enum(['CONFIRMED', 'HYPE', 'STEALTH', 'QUIET']).nullable().catch(() => {
  console.warn('[board] signals.quadrant out of enum — coerced to null (the worker may be writing a bad quadrant)')
  return null
})

export const BoardRowSchema = z.object({
  rank: z.number().int(), // 1-based, from the canonical JS sort position (matches signals.rank)
  ticker: z.string(),
  name: z.string(), // prettyName(ticker_names.name); '' when unknown
  // empirical (always present at the window)
  mentions: z.number().nullable(),
  authors: z.number().nullable(),
  sov: z.number().nullable(),
  velocity: z.number().nullable(),
  accel: z.number().nullable(),
  z: z.number().nullable(),
  netDir: z.number().nullable(),
  ddCount: z.number().nullable(),
  baselineStatus: z.string().nullable(),
  hE: z.number().nullable(),
  // signals (publish-time effective H_m + Attention×Action; null for non-overlaid tickers)
  hM: z.number().nullable(),
  divergence: z.number().nullable(),
  quadrant: QuadrantSchema,
  rankDelta: z.number().nullable(),
  // market overlay (day-to-date; null when no overlay this window — see porting-spec §5/§11)
  ret: z.number().nullable(),
  rvol: z.number().nullable(),
  rvolConf: z.string().nullable(),
  marketFeed: z.string().nullable(),
  retVolBaseline: z.number().nullable(),
  volumeBaseline: z.number().nullable(),
  profileSessions: z.number().int().nullable(),
  marketAsOf: z.number().nullable(),
})

export const MoverSchema = z.object({
  kind: z.string(), // active | gainer | loser
  rank: z.number().int(),
  symbol: z.string().nullable(),
  name: z.string(),
  price: z.number().nullable(),
  percentChange: z.number().nullable(),
  volume: z.number().nullable(),
  ts: z.number(), // screener capture epoch (independent of the board window)
})

export const WindowSchema = z.object({
  start: z.number(),
  scoringVersion: z.string().nullable(),
  end: z.number(),
  generatedAt: z.number().nullable(),
  finalizedAt: z.number().nullable(),
  totalMentions: z.number().nullable(),
  quiet: z.boolean().nullable(),
  capped: z.boolean().nullable(),
  newestUtc: z.number().nullable(),
  newestPostUtc: z.number().nullable(),
  newestCommentUtc: z.number().nullable(),
  marketStatus: z.enum(['fresh', 'partial', 'preserved', 'unavailable', 'disabled']).nullable(),
  marketRequested: z.number().int().nullable(),
  marketUsable: z.number().int().nullable(),
  marketAsOf: z.number().nullable(),
})

export const SourceRunSchema = z.object({
  source: z.string(),
  status: z.enum(['fresh', 'partial', 'capped', 'stale', 'no-data']),
  pollTs: z.number(),
  newestUtc: z.number().nullable(),
  lagSeconds: z.number().nullable(),
  itemsFetched: z.number().int(),
  capped: z.boolean(),
})

export const BoardResponseSchema = z.object({
  // ok = board has rows · empty = latest complete window has no tickers · no-data = no complete window yet
  state: z.enum(['ok', 'empty', 'no-data']),
  window: WindowSchema.nullable(),
  // thresholds the client needs to derive staleness/age relative to ITS clock (avoids cached-HTML drift)
  thresholds: z.object({ windowSeconds: z.number(), maxStalenessSeconds: z.number() }),
  source: z.object({
    posts: SourceRunSchema.nullable(),
    comments: SourceRunSchema.nullable(),
  }),
  rows: z.array(BoardRowSchema),
  movers: z.array(MoverSchema),
})

export type Quadrant = NonNullable<z.infer<typeof QuadrantSchema>>
export type BoardRow = z.infer<typeof BoardRowSchema>
export type Mover = z.infer<typeof MoverSchema>
export type BoardWindow = z.infer<typeof WindowSchema>
export type SourceRun = z.infer<typeof SourceRunSchema>
export type BoardResponse = z.infer<typeof BoardResponseSchema>
