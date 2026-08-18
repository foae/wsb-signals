/**
 * GET /api/media/** — serve archived play screenshots straight off the shared media volume (plays-plan
 * §1; the worker writes `<mediaDir>/<post_id>/<n>.<ext>`, this route reads it). All path validation —
 * the strict shape check AND the resolve/prefix traversal guard — lives in the pure, unit-tested
 * `resolveMediaPath` (server/utils/media-path.ts).
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'

import { resolveMediaPath } from '../../utils/media-path'

export default defineEventHandler(async (event) => {
  const root = useRuntimeConfig().mediaDir
  const resolved = resolveMediaPath(root, event.context.params?.path ?? '')
  if (!resolved) throw createError({ statusCode: 404, statusMessage: 'not found' })

  try {
    const s = await stat(resolved.full)
    if (!s.isFile()) throw new Error('not a file')
    setHeader(event, 'Content-Length', s.size)
  } catch {
    throw createError({ statusCode: 404, statusMessage: 'not found' })
  }

  setHeader(event, 'Content-Type', resolved.contentType)
  // Archived media is immutable (a retry overwrites with the same source bytes) — cache hard.
  setHeader(event, 'Cache-Control', 'public, max-age=86400, immutable')
  return sendStream(event, createReadStream(resolved.full))
})
