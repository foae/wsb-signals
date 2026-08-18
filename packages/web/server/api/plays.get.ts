/**
 * GET /api/plays — the newest captured plays for the bare P1 list. Same contract style as /api/board:
 * read via the shared util, Zod-validate the assembled payload, map DB failure to a 503.
 */
import { PlaysResponseSchema, readPlays } from '../utils/plays'
import { useDb } from '../utils/db'

export default defineEventHandler(async () => {
  let rows
  try {
    rows = await readPlays(useDb())
  } catch (err) {
    throw createError({ statusCode: 503, statusMessage: 'plays unavailable', cause: err })
  }
  return PlaysResponseSchema.parse({ plays: rows })
})
