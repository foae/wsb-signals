/**
 * GET /api/plays — the filtered/sorted plays card list. Same contract style as /api/board: read via
 * the shared util, Zod-validate the assembled payload, map DB failure to a 503. Query params are
 * Zod-parsed (PlaysQuerySchema); a malformed value is a 400, never a silent full-list fallback.
 */
import { PlaysQuerySchema, PlaysResponseSchema, readPlays } from '../utils/plays'
import { useDb } from '../utils/db'

export default defineEventHandler(async (event) => {
  const parsed = PlaysQuerySchema.safeParse(getQuery(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'invalid plays query', cause: parsed.error })
  }

  let rows
  try {
    rows = await readPlays(useDb(), parsed.data)
  } catch (err) {
    throw createError({ statusCode: 503, statusMessage: 'plays unavailable', cause: err })
  }
  return PlaysResponseSchema.parse({ plays: rows })
})
