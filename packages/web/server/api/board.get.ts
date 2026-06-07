/**
 * GET /api/board — the latest complete cycle's board for the SSR page (slice 8). Reads via the
 * snapshot-isolated `readBoard()`, attaches the display thresholds, Zod-validates the payload, and maps
 * any DB failure to a 503 (so a transient DB blip surfaces as an error banner, not a cached bad board).
 * Route caching (60s SWR) is declared in nuxt.config `routeRules`; thrown errors are not cached.
 */
import { readBoard } from '../utils/board'
import { useDb } from '../utils/db'
import { BoardResponseSchema } from '../utils/schemas'

export default defineEventHandler(async () => {
  const cfg = useRuntimeConfig()
  const thresholds = {
    windowSeconds: Number(cfg.windowSeconds),
    maxStalenessSeconds: Number(cfg.maxStalenessSeconds),
  }

  let raw
  try {
    raw = await readBoard(useDb())
  } catch (err) {
    throw createError({ statusCode: 503, statusMessage: 'board unavailable', cause: err })
  }

  const payload = {
    state: raw.state,
    window: raw.window
      ? { ...raw.window, end: raw.window.start + thresholds.windowSeconds }
      : null,
    thresholds,
    rows: raw.rows,
    movers: raw.movers,
  }

  // Validate our own assembled payload — catches read/schema drift before it reaches the client.
  return BoardResponseSchema.parse(payload)
})
