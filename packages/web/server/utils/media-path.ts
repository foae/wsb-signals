/**
 * Path validation for the /api/media/** route — pure (no Nitro/h3 imports) so the security control is
 * unit-testable. The requested path comes from the URL, so it is validated twice (LAN-only lowers the
 * traversal concern, it doesn't remove it — plays-plan §6):
 *  1. a strict shape check — exactly `<post_id>/<n>.<ext>` with the alphabet the worker actually writes;
 *  2. resolve + prefix check against the media root (defense in depth for anything the regex misses).
 */
import { resolve, sep } from 'node:path'

/** `<reddit post id>/<order>.<ext>` — the only filename shape plays/media.ts ever writes. */
const MEDIA_PATH_RE = /^[A-Za-z0-9_-]+\/\d+\.(jpg|png|webp|gif)$/

export const MEDIA_CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
}

/** Absolute file path + content type for a valid request, or null for anything malformed/escaping. */
export function resolveMediaPath(root: string, rel: string): { full: string; contentType: string } | null {
  if (!root) return null
  const m = rel.match(MEDIA_PATH_RE)
  if (!m) return null
  const rootAbs = resolve(root)
  const full = resolve(rootAbs, rel)
  if (!full.startsWith(rootAbs + sep)) return null
  return { full, contentType: MEDIA_CONTENT_TYPES[m[1]!]! }
}
