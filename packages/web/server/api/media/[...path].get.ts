/**
 * GET /api/media/** — serve archived play screenshots straight off the shared media volume (plays-plan
 * §1; the worker writes `<mediaDir>/<post_id>/<n>.<ext>`, this route reads it).
 *
 * The requested path comes from the URL, so it is validated twice (LAN-only lowers the traversal
 * concern, it doesn't remove it — plays-plan §6):
 *  1. a strict shape check — exactly `<post_id>/<n>.<ext>` with the alphabet the worker actually writes;
 *  2. resolve + prefix check against the media root (defense in depth for anything the regex misses).
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

/** `<reddit post id>/<order>.<ext>` — the only filename shape plays/media.ts ever writes. */
const MEDIA_PATH_RE = /^[A-Za-z0-9_-]+\/\d+\.(jpg|png|webp|gif)$/

const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
}

export default defineEventHandler(async (event) => {
  const root = useRuntimeConfig().mediaDir
  if (!root) throw createError({ statusCode: 404, statusMessage: 'media volume not configured' })

  const rel = event.context.params?.path ?? ''
  const m = rel.match(MEDIA_PATH_RE)
  if (!m) throw createError({ statusCode: 404, statusMessage: 'not found' })

  const rootAbs = resolve(root)
  const full = resolve(rootAbs, rel)
  if (!full.startsWith(rootAbs + sep)) throw createError({ statusCode: 404, statusMessage: 'not found' })

  try {
    const s = await stat(full)
    if (!s.isFile()) throw new Error('not a file')
    setHeader(event, 'Content-Length', s.size)
  } catch {
    throw createError({ statusCode: 404, statusMessage: 'not found' })
  }

  setHeader(event, 'Content-Type', CONTENT_TYPES[m[1]!]!)
  // Archived media is immutable (a retry overwrites with the same source bytes) — cache hard.
  setHeader(event, 'Cache-Control', 'public, max-age=86400, immutable')
  return sendStream(event, createReadStream(full))
})
