/**
 * Plays media resolver + archiver (P1, plays-plan §3; shapes per product §3).
 *
 * Capture is the one reliable moment the media exists — Reddit deletes gain-porn posts routinely
 * (invariant P7) — so this archives to the shared volume (`<mediaDir>/<post_id>/<n>.<ext>`) at
 * `captured → media_ready`. The shape-specific landmines:
 *  - **Gallery**: resolved LOCALLY from the archived raw dict first — Arctic-Shift archives
 *    `gallery_data` + `media_metadata` for fresh gallery posts (verified live at the P1 gate,
 *    2026-08-18; the design-time "null media_metadata" observation was from stale archives). Reddit's
 *    public post JSON (`https://www.reddit.com<permalink>.json`) is only the fallback for a
 *    metadata-less raw — and 403-blocks non-browser clients from many networks, so expect degrades on
 *    that path. Image ORDER comes from `gallery_data.items[].media_id` (`media_metadata` alone is an
 *    UNORDERED keyed object, and the first image is nearly always the position screenshot — a cap must
 *    take the first N, not an arbitrary subset); `media_metadata` supplies the extension via its mime.
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
import { join, resolve, sep } from 'node:path'

import { fetch as undiciFetch } from 'undici'

import type { PlayMediaItem, PlayRow } from '@wsb/shared'

import type { PlaysConfig } from '../config'
import type { RawThing, Sleeper } from '../ingest'
import { log } from '../logger'

const DIRECT_IMAGE_RE = /^https?:\/\/i\.redd\.it\/[\w-]+\.(jpe?g|png|webp|gif)$/i
/** Per-fetch deadline — spans the WHOLE response (headers AND body): the signal from
 *  `AbortSignal.timeout` keeps governing `res.body` reads, so a tarpit that dribbles bytes after 200
 *  can't hang the queue tick (and thus shutdown) indefinitely. */
const FETCH_TIMEOUT_MS = 30_000
/** In-stage bounded retry for a transient fetch (the queue's media_retry_until window sits above this). */
const MAX_FETCH_RETRIES = 2
const RETRY_BACKOFF_MS = 500
/** Whole-stage time budget. Keeps the worst case (many images × retries × timeouts) WELL under the
 *  queue's lease_minutes — past it, remaining images are counted transient and the play retries next
 *  tick instead of overrunning its lease into a double-claim (plays-plan §3). */
const STAGE_BUDGET_MS = 240_000
/** Byte cap on the gallery post-JSON body — an external host must not buffer unbounded into the heap
 *  the radar shares (plays-plan §1's memory rule; the image cap is `max_image_mb`). */
const GALLERY_JSON_CAP = 2 * 1024 * 1024

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
  /** Stage deadline (epoch ms) — defaults to now + STAGE_BUDGET_MS. Injectable for tests. */
  deadlineAt?: number
}

const realSleep: Sleeper = (ms) => new Promise((r) => setTimeout(r, ms))

/** How a failed fetch should be handled downstream. `aborted` (shutdown) is its OWN kind — treating it
 *  as permanent turned every SIGTERM mid-stage into a permanent text-only degrade (P7 violation; the
 *  queue must release the claim unchanged instead), and treating it as transient would burn the
 *  media_retry_until window on restarts. */
type FetchFailKind = 'transient' | 'permanent' | 'aborted'
type FetchOutcome =
  | { ok: true; res: Awaited<ReturnType<Fetcher>>; done: () => void }
  | { ok: false; kind: FetchFailKind; detail: string }

/** One fetch with a full-response deadline + shutdown signal + bounded transient retry. Returns the
 *  response only on 200; the caller MUST consume the body and then call `done()` — the timeout keeps
 *  governing body reads until then (see FETCH_TIMEOUT_MS). */
async function fetchOk(url: string, deps: MediaDeps): Promise<FetchOutcome> {
  const fetchImpl = deps.fetchImpl ?? undiciFetch
  const sleep = deps.sleep ?? realSleep
  for (let attempt = 0; ; attempt++) {
    let kind: FetchFailKind = 'permanent'
    let detail = ''
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(new Error(`timeout after ${FETCH_TIMEOUT_MS}ms`)), FETCH_TIMEOUT_MS)
      timer.unref?.()
      const signal = deps.signal ? AbortSignal.any([ac.signal, deps.signal]) : ac.signal
      let res
      try {
        res = await fetchImpl(url, {
          method: 'GET',
          headers: { 'User-Agent': deps.config.redditUserAgent },
          signal,
        })
      } catch (e) {
        clearTimeout(timer)
        throw e
      }
      // NOTE: the timer is NOT cleared on the success path — it stays armed while the caller streams
      // the body (undici aborts in-flight body reads when the request signal fires), and `done()`
      // disarms it. Cleared here only on the non-200 paths below.
      if (res.status === 200) return { ok: true, res, done: () => clearTimeout(timer) }
      clearTimeout(timer)
      await res.body?.cancel().catch(() => {})
      // 403/404/410 = deleted/blocked (permanent — the media is not coming back); 429/5xx = transient.
      kind = res.status === 429 || res.status >= 500 ? 'transient' : 'permanent'
      detail = `status ${res.status}`
    } catch (e) {
      if (deps.signal?.aborted) return { ok: false, kind: 'aborted', detail: 'shutdown' }
      kind = 'transient' // network error / timeout
      detail = String(e)
    }
    if (kind !== 'transient' || attempt >= MAX_FETCH_RETRIES) return { ok: false, kind, detail }
    await sleep(RETRY_BACKOFF_MS * 2 ** attempt)
    if (deps.signal?.aborted) return { ok: false, kind: 'aborted', detail: 'shutdown' }
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
  | { kind: 'images'; images: ResolvedImage[]; detail?: string } // detail = resolution-time caveat (e.g. partial gallery metadata)
  | { kind: 'none' }
  | { kind: 'gone'; detail: string } // permanent — degrade to text-only now
  | { kind: 'transient'; detail: string } // retry within the media_retry_until window
  | { kind: 'aborted' } // shutdown — the queue releases the claim UNCHANGED (no window, no degrade)

/** The gallery item list + keyed metadata, both defensively narrowed: `raw` comes from an external
 *  archive, so `items` can be any shape and `media_metadata` can be a primitive — a malformed dict
 *  must resolve to nothing, never throw (a throw here is a stage crash that burns the play toward
 *  terminal `failed` when text-only analysis was still possible). */
function galleryParts(postData: RawThing): { items: unknown[]; mm: Record<string, unknown> } {
  const gd = postData.gallery_data as { items?: unknown } | null | undefined
  const rawItems = gd?.items
  const mmRaw = postData.media_metadata
  return {
    items: Array.isArray(rawItems) ? rawItems : [],
    mm: mmRaw != null && typeof mmRaw === 'object' ? (mmRaw as Record<string, unknown>) : {},
  }
}

const galleryItemId = (item: unknown): string | undefined => {
  const id = item != null && typeof item === 'object' ? (item as { media_id?: unknown }).media_id : undefined
  return typeof id === 'string' ? id : undefined
}

/** Order + extension from a gallery payload (the archived raw dict or the fetched post JSON — same
 *  shape). Exported for the unit tests — this parse is where the ordered-subset landmine lives. */
export function galleryImages(postData: RawThing, maxImages: number): ResolvedImage[] {
  const { items, mm } = galleryParts(postData)
  const out: ResolvedImage[] = []
  for (const item of items) {
    if (out.length >= maxImages) break // first-N in gallery order, never an arbitrary subset
    const id = galleryItemId(item)
    if (id === undefined) continue
    const meta = mm[id] as { status?: unknown; e?: unknown; m?: unknown } | null | undefined
    if (meta == null || typeof meta !== 'object') continue
    if ((meta.status != null && meta.status !== 'valid') || (meta.e != null && meta.e !== 'Image')) continue
    const ext = typeof meta.m === 'string' ? MIME_EXT[meta.m] : undefined
    if (!ext) continue // non-image / unknown mime (video, animated) — out of scope for v1
    out.push({ order: out.length, url: `https://i.redd.it/${id}.${ext}`, ext })
  }
  return out
}

/** True when every gallery_data image slot has SOME `media_metadata` entry — then local resolution's
 *  skips are deliberate (video/invalid entries), not holes. False = the archived metadata is partial:
 *  resolving locally would silently drop images AND renumber the rest, so the resolver must try the
 *  post-JSON fallback first (P1 review round 2). Exported for the unit tests. */
export function galleryMetadataComplete(postData: RawThing): boolean {
  const { items, mm } = galleryParts(postData)
  return items.every((item) => {
    const id = galleryItemId(item)
    return id === undefined ? true : mm[id] != null // a junk id resolves nowhere — not a metadata hole
  })
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
    // Local-first (P1 gate finding, 2026-08-18): Arctic-Shift DOES archive `gallery_data` +
    // `media_metadata` for fresh gallery posts — the design-time "archived as null" observation does
    // not hold at capture time — and the Reddit post-JSON endpoint 403-blocks non-browser clients
    // from this network. The archived dict is trusted only when its metadata is COMPLETE; with holes
    // (or nothing) the post-JSON fetch is tried, and a partial local subset is the floor on fetch
    // failure — some screenshots beat text-only (P7), and the fetch mostly 403s anyway.
    const local = galleryImages(raw, max)
    if (local.length > 0 && galleryMetadataComplete(raw)) return { kind: 'images', images: local }
    const orPartial = (fail: Resolution, why: string): Resolution =>
      local.length > 0
        ? { kind: 'images', images: local, detail: `archived gallery metadata incomplete; json fallback failed (${why}) — archiving the resolvable subset` }
        : fail

    const permalink = play.permalink
    if (!permalink) return orPartial({ kind: 'gone', detail: 'gallery post without permalink' }, 'no permalink')
    // raw_json=1 keeps URLs unescaped in the payload.
    const r = await fetchOk(`https://www.reddit.com${permalink}.json?raw_json=1`, deps)
    if (!r.ok) {
      if (r.kind === 'aborted') return { kind: 'aborted' }
      // Counts only fallback-path fetches (missing/partial archived metadata) since local-first landed.
      log.warn({ playId: play.id, detail: r.detail }, 'plays media: gallery post-JSON fetch failed')
      return r.kind === 'transient'
        ? orPartial({ kind: 'transient', detail: `gallery json: ${r.detail}` }, r.detail)
        : orPartial({ kind: 'gone', detail: `gallery json: ${r.detail}` }, r.detail)
    }
    let postData: RawThing
    try {
      const body = await readCapped(r.res, GALLERY_JSON_CAP) // capped — never buffer unbounded JSON
      if (!body.ok) return orPartial({ kind: 'gone', detail: `gallery json: ${body.detail}` }, body.detail)
      const json = JSON.parse(body.buf.toString('utf8')) as { data?: { children?: { data?: RawThing }[] } }[]
      postData = json[0]?.data?.children?.[0]?.data ?? {}
    } catch (e) {
      if (deps.signal?.aborted) return { kind: 'aborted' }
      // Interstitial/HTML/timeout — likely transient.
      return orPartial({ kind: 'transient', detail: `gallery json parse: ${String(e)}` }, String(e))
    } finally {
      r.done()
    }
    const images = galleryImages(postData, max)
    if (images.length === 0) {
      // A live-JSON gallery with no valid images = removed or all-video — permanent either way.
      return orPartial(
        { kind: 'gone', detail: 'gallery resolved to no images (removed or non-image entries)' }, 'json had no images')
    }
    return { kind: 'images', images }
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
  /** Archived items, gallery order preserved — including items REUSED from a prior attempt (persisted
   *  in `plays.media` when a retry was scheduled), so an image archived on attempt 1 and deleted
   *  upstream before attempt 2 is never lost from the manifest. */
  items: PlayMediaItem[]
  /** ≥1 fetch failed transiently — worth another pass within the `media_retry_until` window. */
  retryable: boolean
  /** The post never had resolvable media (text-only by construction). */
  none: boolean
  /** Shutdown aborted the stage mid-flight. The queue must release the claim UNCHANGED — advancing
   *  would permanently degrade the play to text-only over a restart (P7), and opening the retry
   *  window would burn it on every deploy. */
  aborted: boolean
  detail?: string
}

const stageResult = (over: Partial<MediaStageResult>): MediaStageResult =>
  ({ items: [], retryable: false, none: false, aborted: false, ...over })

/**
 * Resolve + download + archive one play's media. Never throws for fetch-level trouble — the result tells
 * the queue whether to advance (`items`/`none`), retry (`retryable`), release (`aborted`), or degrade.
 * Filesystem errors DO throw (disk-full is a queue-level fault, not a media state). Bounded by
 * STAGE_BUDGET_MS so the stage can never outrun the queue's claim lease.
 */
export async function runMediaStage(play: PlayRow, deps: MediaDeps): Promise<MediaStageResult> {
  const resolved = await resolveImages(play, deps)
  if (resolved.kind === 'none') return stageResult({ none: true })
  if (resolved.kind === 'aborted') return stageResult({ aborted: true })
  if (resolved.kind === 'gone') return stageResult({ detail: resolved.detail })
  if (resolved.kind === 'transient') return stageResult({ retryable: true, detail: resolved.detail })

  // Defense in depth: capture validates the id shape, but a path-capable id (e.g. `../x`) from a
  // corrupt upstream dict must never escape the media root — this is a WRITE path.
  const rootAbs = resolve(deps.config.mediaDir)
  const dir = resolve(rootAbs, play.id)
  if (!dir.startsWith(rootAbs + sep)) {
    return stageResult({ detail: `unsafe play id ${JSON.stringify(play.id)} — refusing to archive` })
  }
  await mkdir(dir, { recursive: true })

  // Items archived by a PRIOR attempt (persisted on retry scheduling) — reused instead of re-fetched:
  // the file is already on disk with its hash recorded, and the source may since have been deleted.
  const prior = new Map((Array.isArray(play.media) ? (play.media as PlayMediaItem[]) : [])
    .map((it) => [`${it.order}|${it.sourceUrl}`, it]))

  const deadlineAt = deps.deadlineAt ?? Date.now() + STAGE_BUDGET_MS
  const items: PlayMediaItem[] = []
  let transient = 0
  // A resolution-time caveat (partial gallery metadata) surfaces in the final detail like any failure.
  const failures: string[] = resolved.detail ? [resolved.detail] : []
  for (const img of resolved.images) {
    const reused = prior.get(`${img.order}|${img.url}`)
    if (reused) {
      items.push(reused)
      continue
    }
    if (Date.now() > deadlineAt) {
      // Stage budget exhausted: count the remainder transient and let the next tick continue — never
      // outrun the claim lease into a double-claim.
      transient++
      failures.push(`#${img.order} stage budget exhausted`)
      continue
    }
    const r = await fetchOk(img.url, deps)
    if (!r.ok) {
      if (r.kind === 'aborted') return stageResult({ items, aborted: true })
      if (r.kind === 'transient') transient++
      failures.push(`#${img.order} ${r.detail}`)
      continue
    }
    let body
    try {
      body = await readCapped(r.res, deps.config.maxImageBytes)
    } catch (e) {
      // Abort mid-body: shutdown → release; deadline/network → transient for this image.
      if (deps.signal?.aborted) return stageResult({ items, aborted: true })
      transient++
      failures.push(`#${img.order} body read failed: ${String(e)}`)
      continue
    } finally {
      r.done()
    }
    if (!body.ok) {
      failures.push(`#${img.order} ${body.detail}`) // oversize — permanent, skip this image
      continue
    }
    // A 200 with an empty body or a non-image content type (CDN error page) is not media — permanent.
    const ctype = r.res.headers.get('content-type')
    if (body.buf.length === 0 || (ctype != null && !ctype.startsWith('image/'))) {
      failures.push(`#${img.order} not an image (${body.buf.length} bytes, ${ctype ?? 'no content-type'})`)
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
  return stageResult({
    items,
    // Retry while any image is transiently missing — already-archived items are persisted by the queue
    // on retry scheduling and reused above, so the partial set can only grow within the window.
    retryable: transient > 0,
    detail: failures.length ? failures.join('; ') : undefined,
  })
}
