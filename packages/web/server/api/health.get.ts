/**
 * GET /api/health — liveness probe for the Docker/compose healthcheck. It opens a trivial `SELECT 1`
 * through the read-only pool, so the container reports healthy ONLY when Postgres is reachable AND the
 * read-only role exists (→ real requests can be served). A static `{ok:true}` stub would report green
 * while every board request 503s (review-gate HIGH). 503 on failure so Docker can restart/flag it.
 */
import { sql } from 'drizzle-orm'

import { useDb } from '../utils/db'

export default defineEventHandler(async () => {
  try {
    await useDb().execute(sql`SELECT 1`)
    return { ok: true }
  } catch (err) {
    throw createError({ statusCode: 503, statusMessage: 'db unavailable', cause: err })
  }
})
