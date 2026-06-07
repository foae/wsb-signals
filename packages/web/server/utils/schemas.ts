/**
 * Zod schemas + inferred types for the `/api/board` response (slice 8). The schema is the single source
 * of truth for the API contract: the server validates its assembled payload before returning (catching
 * any schema/read drift), and the client imports the inferred types.
 */
import { z } from 'zod'

/** Attention×Action quadrant (analytics.ts `Quadrant`). Unknown/missing → null (never 503 the board). */
export const QuadrantSchema = z.enum(['CONFIRMED', 'HYPE', 'STEALTH', 'QUIET']).nullable().catch(null)

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
  end: z.number(), // start + windowSeconds
  generatedAt: z.number().nullable(),
  totalMentions: z.number().nullable(),
  quiet: z.boolean().nullable(),
  capped: z.boolean().nullable(),
  newestUtc: z.number().nullable(),
})

export const BoardResponseSchema = z.object({
  // ok = board has rows · empty = latest complete window has no tickers · no-data = no complete window yet
  state: z.enum(['ok', 'empty', 'no-data']),
  window: WindowSchema.nullable(),
  // thresholds the client needs to derive staleness/age relative to ITS clock (avoids cached-HTML drift)
  thresholds: z.object({ windowSeconds: z.number(), maxStalenessSeconds: z.number() }),
  rows: z.array(BoardRowSchema),
  movers: z.array(MoverSchema),
})

export type Quadrant = NonNullable<z.infer<typeof QuadrantSchema>>
export type BoardRow = z.infer<typeof BoardRowSchema>
export type Mover = z.infer<typeof MoverSchema>
export type BoardWindow = z.infer<typeof WindowSchema>
export type BoardResponse = z.infer<typeof BoardResponseSchema>
