/**
 * Plays media resolver + archiver (P1, plays-plan §3; shapes per product §3).
 *
 * Capture is the one reliable moment the media exists — Reddit deletes gain-porn posts routinely
 * (invariant P7) — so this archives to the shared volume (`<mediaDir>/<post_id>/<n>.<ext>`) at
 * `captured → media_ready`. The shape-specific landmines:
 *  - **Gallery**: Arctic-Shift archives gallery `media_metadata` as null (verified 2026-08-18), so the
 *    image list must come from Reddit's public post JSON (`https://www.reddit.com<permalink>.json`,
 *    browser-ish UA — the post is minutes old). Image ORDER comes from `gallery_data.items[].media_id`
 *    (`media_metadata` alone is an UNORDERED keyed object, and the first image is nearly always the
 *    position screenshot — a cap must take the first N, not an arbitrary subset); `media_metadata`
 *    supplies the extension via its mime.
 *  - **Inline self-post images**: `media_metadata` IS archived for text posts — resolve those instead of
 *    silently dropping to text-only. Order = first appearance of each media id in the selftext (the only
 *    order signal that exists), unknown ids last.
 *  - **Failures split transient vs permanent**: 429/5xx/network retry (bounded, mirroring ingest.ts) and
 *    then remain retryable for the queue's `media_retry_until` window; 403/404/410/oversize are permanent.
 *    Only the queue degrades to text-only, and only after the window (invariant P7).
 *
 * No DB access here — the stage is pure fetch+fs, so no transaction can span it (invariant P9).
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { fetch as undiciFetch } from 'undici'

import type { PlayMediaItem, PlayRow } from '@wsb/shared'

import type { PlaysConfig } from '../config'
import type { RawThing, Sleeper } from '../ingest'
import { log } from '../logger'

const DIRECT_IMAGE_RE = /^https?:\/\/i\.redd\.it\/[\w-]+\.(jpe?g|png|webp|gif)$/i
const FETCH_TIMEOUT_MS = 30_000
/** In-stage bounded retry for a transient fetch (the queue's media_retry_until window sits above this). */
const MAX_FETCH_RETRIES = 2
const RETRY_BACKOFF_MS = 500

/** Reddit gallery mimes → the i.redd.it file extension. Unknown mimes are skipped (video/gif variants
 *  are out of scope for v1 — product §3 keeps them text-only). */
const MIME_EXT: Record<string, string> = {
  'image/jpg': 'jpg', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
}

export interface ResolvedImage {
  order: number
  url: string
  ext: string
}

export type Fetcher = typeof undiciFetch

export interface MediaDeps {
  config: PlaysConfig
  /** Injectable for tests (and the shutdown signal threads through every fetch). */
  fetchImpl?: Fetcher
  sleep?: Sleeper
  signal?: AbortSignal
}

const realSleep: Sleeper = (ms) => new Promise((r) => setTimeout(r, ms))

/** One fetch with timeout + shutdown signal + bounded transient retry. Returns the response only on 200;
 *  otherwise classifies the failure. A shutdown abort is always non-retryable (it's not a fault). */
async function fetchOk(
  url: string, deps: MediaDeps,
): Promise<{ ok: true; res: Awaited<ReturnType<Fetcher>> } | { ok: false; retryable: boolean; detail: string }> {
  const fetchImpl = deps.fetchImpl ?? undiciFetch
  const sleep = deps.sleep ?? realSleep
  for (let attempt = 0; ; attempt++) {
    let retryable = false
    let detail = ''
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(new Error(`timeout after ${FETCH_TIMEOUT_MS}ms`)), FETCH_TIMEOUT_MS)
      timer.unref?.()
      let res
      try {
        res = await fetchImpl(url, {
          method: 'GET',
          headers: { 'User-Agent': deps.config.redditUserAgent },
          signal: deps.signal ? AbortSignal.any([ac.signal, deps.signal]) : ac.signal,
        })
      } finally {
        clearTimeout(timer)
      }
      if (res.status === 200) return { ok: true, res }
      await res.body?.cancel().catch(() => {})
      // 403/404/410 = deleted/blocked (permanent — the media is not coming back); 429/5xx = transient.
      retryable = res.status === 429 || res.status >= 500
      detail = `status ${res.status}`
    } catch (e) {
      if (deps.signal?.aborted) return { ok: false, retryable: false, detail: 'shutdown' }
      retryable = true // network error / timeout
      detail = String(e)
    }
    if (!retryable || attempt >= MAX_FETCH_RETRIES) return { ok: false, retryable, detail }
    await sleep(RETRY_BACKOFF_MS * 2 ** attempt)
    if (deps.signal?.aborted) return { ok: false, retryable: false, detail: 'shutdown' }
  }
}

/** Read a 200 body up to `cap` bytes; abort past it (a missing Content-Length must not buffer a rogue
 *  1 GB "image" into the heap the radar shares — plays-plan §1's memory rule). */
async function readCapped(
  res: Awaited<ReturnType<Fetcher>>, cap: number,
): Promise<{ ok: true; buf: Buffer } | { ok: false; detail: string }> {
  const len = Number(res.headers.get('content-length') ?? 0)
  if (len > cap) {
    await res.body?.cancel().catch(() => {})
    return { ok: false, detail: `content-length ${len} > cap ${cap}` }
  }
  const chunks: Buffer[] = []
  let total = 0
  if (res.body) {
    for await (const chunk of res.body) {
      const b = Buffer.from(chunk)
      total += b.length
      if (total > cap) {
        await res.body.cancel().catch(() => {})
        return { ok: false, detail: `body exceeded cap ${cap}` }
      }
      chunks.push(b)
    }
  }
  return { ok: true, buf: Buffer.concat(chunks) }
}

// --- resolution (post → ordered image URLs) ---------------------------------------------------------

type Resolution =
  | { kind: 'images'; images: ResolvedImage[]; galleryJsonOk?: boolean }
  | { kind: 'none' }
  | { kind: 'gone'; detail: string } // permanent — degrade to text-only now
  | { kind: 'transient'; detail: string } // retry within the media_retry_until window

/** Order + extension from a Reddit post-JSON gallery payload. Exported for the unit tests — this parse
 *  is where the ordered-subset landmine lives. */
export function galleryImages(postData: RawThing, maxImages: number): ResolvedImage[] {
  const gd = postData.gallery_data as { items?: { media_id?: unknown }[] } | null | undefined
  const mm = (postData.media_metadata ?? {}) as Record<string, { status?: unknown; e?: unknown; m?: unknown }>
  const out: ResolvedImage[] = []
  for (const item of gd?.items ?? []) {
    if (out.length >= maxImages) break // first-N in gallery order, never an arbitrary subset
    const id = item.media_id
    if (typeof id !== 'string') continue
    const meta = mm[id]
    if (!meta || (meta.status != null && meta.status !== 'valid') || (meta.e != null && meta.e !== 'Image')) continue
    const ext = typeof meta.m === 'string' ? MIME_EXT[meta.m] : undefined
    if (!ext) continue // non-image / unknown mime (video, animated) — out of scope for v1
    out.push({ order: out.length, url: `https://i.redd.it/${id}.${ext}`, ext })
  }
  return out
}

/** Inline self-post images from the archived `media_metadata`, ordered by first appearance of each media
 *  id in the selftext (unknown ids last, key order). Prefers the signed preview.redd.it URL embedded in
 *  the selftext when present (i.redd.it is the fallback). Exported for the unit tests. */
export function inlineImages(raw: RawThing, maxImages: number): ResolvedImage[] {
  const mm = raw.media_metadata
  if (mm == null || typeof mm !== 'object') return []
  const selftext = typeof raw.selftext === 'string' ? raw.selftext : ''
  const entries = Object.entries(mm as Record<string, { status?: unknown; e?: unknown; m?: unknown }>)
    .flatMap(([id, meta]) => {
      if (!meta || (meta.status != null && meta.status !== 'valid') || (meta.e != null && meta.e !== 'Image')) return []
      const ext = typeof meta.m === 'string' ? MIME_EXT[meta.m] : undefined
      return ext ? [{ id, ext }] : []
    })
  const pos = (id: string): number => {
    const i = selftext.indexOf(id)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }
  entries.sort((a, b) => pos(a.id) - pos(b.id))
  return entries.slice(0, maxImages).map(({ id, ext }, order) => {
    // The selftext embeds signed preview URLs (`preview.redd.it/<id>.<ext>?…&s=<sig>`, HTML-escaped by
    // Reddit); use one when present — the signature is required there — else the canonical i.redd.it.
    const m = selftext.match(new RegExp(`https://preview\\.redd\\.it/${id}\\.\\w+\\?[^\\s)\\]"]+`))
    const url = m ? m[0].replace(/&amp;/g, '&') : `https://i.redd.it/${id}.${ext}`
    return { order, url, ext }
  })
}

/** Resolve a play's ordered image list per its media shape (product §3). Network only for galleries. */
export async function resolveImages(play: PlayRow, deps: MediaDeps): Promise<Resolution> {
  const raw = (play.raw ?? {}) as RawThing
  const max = deps.config.maxImagesStored

  if (play.isGallery) {
    const permalink = play.permalink
    if (!permalink) return { kind: 'gone', detail: 'gallery post without permalink' }
    // raw_json=1 keeps URLs unescaped in the payload.
    const r = await fetchOk(`https://www.reddit.com${permalink}.json?raw_json=1`, deps)
    if (!r.ok) {
      log.warn({ playId: play.id, detail: r.detail }, 'plays media: gallery post-JSON fetch failed') // gate metric
      return r.retryable ? { kind: 'transient', detail: `gallery json: ${r.detail}` }
        : { kind: 'gone', detail: `gallery json: ${r.detail}` }
    }
    let postData: RawThing
    try {
      const json = (await r.res.json()) as { data?: { children?: { data?: RawThing }[] } }[]
      postData = json[0]?.data?.children?.[0]?.data ?? {}
    } catch (e) {
      return { kind: 'transient', detail: `gallery json parse: ${String(e)}` } // interstitial/HTML — likely transient
    }
    const images = galleryImages(postData, max)
    if (images.length === 0) {
      // A live-JSON gallery with no valid images = removed or all-video — permanent either way.
      return { kind: 'gone', detail: 'gallery resolved to no images (removed or non-image entries)' }
    }
    return { kind: 'images', images, galleryJsonOk: true }
  }

  if (play.url && DIRECT_IMAGE_RE.test(play.url)) {
    const ext = play.url.match(DIRECT_IMAGE_RE)![1]!.toLowerCase().replace('jpeg', 'jpg')
    return { kind: 'images', images: [{ order: 0, url: play.url, ext }] }
  }

  const inline = inlineImages(raw, max)
  if (inline.length > 0) return { kind: 'images', images: inline }

  return { kind: 'none' } // defensive — capture only marks `pending` for the shapes above
}

// --- the stage --------------------------------------------------------------------------------------

export interface MediaStageResult {
  /** Archived items, gallery order preserved. Idempotent: a retry re-downloads and overwrites. */
  items: PlayMediaItem[]
  /** ≥1 fetch failed transiently — worth another pass within the `media_retry_until` window. */
  retryable: boolean
  /** The post never had resolvable media (text-only by construction). */
  none: boolean
  detail?: string
}

/**
 * Resolve + download + archive one play's media. Never throws for fetch-level trouble — the result tells
 * the queue whether to advance (`items`/`none`), retry (`retryable`), or degrade. Filesystem errors DO
 * throw (disk-full is a queue-level fault, not a media state).
 */
export async function runMediaStage(play: PlayRow, deps: MediaDeps): Promise<MediaStageResult> {
  const resolved = await resolveImages(play, deps)
  if (resolved.kind === 'none') return { items: [], retryable: false, none: true }
  if (resolved.kind === 'gone') return { items: [], retryable: false, none: false, detail: resolved.detail }
  if (resolved.kind === 'transient') return { items: [], retryable: true, none: false, detail: resolved.detail }

  const dir = join(deps.config.mediaDir, play.id)
  await mkdir(dir, { recursive: true })

  const items: PlayMediaItem[] = []
  let transient = 0
  const failures: string[] = []
  for (const img of resolved.images) {
    const r = await fetchOk(img.url, deps)
    if (!r.ok) {
      if (r.retryable) transient++
      failures.push(`#${img.order} ${r.detail}`)
      continue
    }
    const body = await readCapped(r.res, deps.config.maxImageBytes)
    if (!body.ok) {
      failures.push(`#${img.order} ${body.detail}`) // oversize — permanent, skip this image
      continue
    }
    const filename = `${img.order}.${img.ext}`
    await writeFile(join(dir, filename), body.buf)
    items.push({
      order: img.order,
      path: `${play.id}/${filename}`, // relative to the media root (worker/web mount points differ)
      ext: img.ext,
      bytes: body.buf.length,
      sha256: createHash('sha256').update(body.buf).digest('hex'),
      sourceUrl: img.url,
    })
  }
  return {
    items,
    // Retry while any image is transiently missing — archiving is idempotent, and a partial set should
    // become the full set if the blip clears within the window.
    retryable: transient > 0,
    none: false,
    detail: failures.length ? failures.join('; ') : undefined,
  }
}
