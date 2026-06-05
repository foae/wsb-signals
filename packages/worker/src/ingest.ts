/**
 * Arctic-Shift ingestion client — TS port of the frozen v0.0.1 `wsb_signals/sources/arctic_shift.py`
 * (porting-spec §4). The sole live Reddit tap: a paginated *descending* walk over
 * `/{posts,comments}/search`, tracking the `before` cursor back to the window cutoff.
 *
 * Parity-critical landmines reproduced here (porting-spec §4 + §8 checklist):
 *  - `before = now + 5` (deliberate +5s skew buffer); `cutoff = now - windowSeconds`.
 *  - per-page STOP on: empty `data`, `oldest <= cutoff`, or `len(data) < pageLimit`. Ran ALL `maxPages`
 *    without a stop → `capped = true` (the Python `for…else`).
 *  - `ok = false` on ANY {network error, non-200, non-JSON} mid-walk → break, return PARTIAL. The caller
 *    DISCARDS an `ok=false` poll whole (slice 6) — it would undercount the SoV denominator.
 *  - `capped` (page cap hit) is the BENIGN undercount: persisted but low-trust — the OPPOSITE persistence
 *    of `ok=false`. Don't conflate them.
 *  - rate-limit: honor `X-RateLimit-Remaining`; back off 2s only when it parses as a STRICT integer < 50.
 *    Python `int()` raises on non-numeric (→ ignore); JS `parseInt` is lenient and WOULD mis-trigger, so
 *    we gate on a strict integer regex (the garbage-header landmine — porting-spec §9 fault test).
 *  - `oldest` default-fills a missing `created_utc` with `now`; the in-window filter default-fills with
 *    `0` — DIFFERENT defaults, faithful to Python `dict.get(k, now)` vs `dict.get(k, 0)`. A thing with no
 *    timestamp thus never drags `oldest` down yet is excluded from the window.
 *  - HTTP client (undici `fetch`) does NOT throw on 4xx/5xx — we check `res.status` manually (httpx
 *    parity). A throw-on-non-2xx client (e.g. ofetch) would INVERT the `ok` logic.
 */
import { fetch, type Response } from 'undici'

import type { RawCommentInsert, RawPostInsert } from '@wsb/shared'

import { log } from './logger'

const SOURCE = 'arctic_shift'

/** A raw thing as it arrives from Arctic-Shift — snake_case Reddit keys, untyped values. */
type RawThing = Record<string, unknown>

export interface PollResult {
  posts: RawPostInsert[]
  comments: RawCommentInsert[]
  newestUtc: number | null // freshest normalized item seen — feeds the heartbeat
  capped: boolean // pagination hit the page cap (window undercounted, but benign)
  ok: boolean // false if a fetch errored mid-pagination (partial — caller discards whole)
}

export interface PollOptions {
  /** Injected wall clock (epoch seconds). Defaults to `Math.floor(Date.now()/1000)` — the Python `now`. */
  now?: number
  /** Override the inter-page / rate-limit backoff (tests pass a recording no-op to avoid real waits). */
  sleep?: Sleeper
}

export interface Source {
  readonly name: string
  poll(windowSeconds: number, opts?: PollOptions): Promise<PollResult>
  close(): Promise<void>
}

/** Injectable so tests record/zero the inter-page (0.3s) and rate-limit (2s) backoffs without real waits. */
export type Sleeper = (ms: number) => Promise<void>
const realSleep: Sleeper = (ms) => new Promise((r) => setTimeout(r, ms))

// --- Python value-coercion parity ------------------------------------------------------------------

/** Python `str(x)` parity, incl. the realistic-but-edge case: a missing id → the literal string "None". */
function pyStr(v: unknown): string {
  return v === null || v === undefined ? 'None' : String(v)
}

/** Python `int(x or 0)` with truncation-toward-zero. Missing/null/0/"" → 0; floats truncate. */
function intOrZero(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v ?? 0)
  if (!Number.isFinite(n) || n === 0) return 0 // NaN/±Inf/0/falsy → 0 (Python `x or 0`)
  return Math.trunc(n)
}

/** Raw (un-truncated) `created_utc` for window math; `dict.get("created_utc", fallback)` parity. */
function createdUtcRaw(x: RawThing, fallback: number): number {
  const v = x.created_utc
  return typeof v === 'number' ? v : fallback
}

// --- B2 normalization (from_arctic) ----------------------------------------------------------------

/** Port of `RawPost.from_arctic` — snake_case API dict → the camelCase insert row (B2 boundary). */
export function normalizePost(d: RawThing, retrievedOn: number): RawPostInsert {
  return {
    id: pyStr(d.id),
    createdUtc: intOrZero(d.created_utc),
    author: (d.author ?? null) as string | null,
    title: (d.title ?? null) as string | null,
    selftext: (d.selftext ?? null) as string | null,
    linkFlairText: (d.link_flair_text ?? null) as string | null,
    score: (d.score ?? null) as number | null,
    numComments: (d.num_comments ?? null) as number | null,
    retrievedOn,
    source: SOURCE,
  }
}

/** Port of `RawComment.from_arctic` — comments have no title/selftext/num_comments; carry link/parent ids. */
export function normalizeComment(d: RawThing, retrievedOn: number): RawCommentInsert {
  return {
    id: pyStr(d.id),
    createdUtc: intOrZero(d.created_utc),
    author: (d.author ?? null) as string | null,
    linkId: (d.link_id ?? null) as string | null,
    parentId: (d.parent_id ?? null) as string | null,
    body: (d.body ?? null) as string | null,
    score: (d.score ?? null) as number | null,
    retrievedOn,
    source: SOURCE,
  }
}

// --- the client ------------------------------------------------------------------------------------

export interface ArcticShiftOptions {
  pageLimit?: number
  maxPages?: number
  userAgent?: string
  timeoutMs?: number
  sleep?: Sleeper
}

export class ArcticShiftSource implements Source {
  readonly name = SOURCE
  private readonly baseUrl: string
  private readonly subreddit: string
  private readonly pageLimit: number
  private readonly maxPages: number
  private readonly userAgent: string
  private readonly timeoutMs: number
  private readonly sleep: Sleeper

  constructor(baseUrl: string, subreddit: string, opts: ArcticShiftOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '') // Python `base_url.rstrip("/")`
    this.subreddit = subreddit
    this.pageLimit = opts.pageLimit ?? 100
    this.maxPages = opts.maxPages ?? 60
    this.userAgent = opts.userAgent ?? 'wsb-signals/0.0.1'
    this.timeoutMs = opts.timeoutMs ?? 60_000
    this.sleep = opts.sleep ?? realSleep
  }

  /** undici `fetch` holds no per-client connection to release (global dispatcher) — a no-op for symmetry. */
  async close(): Promise<void> {}

  private async get(kind: string, cutoff: number, before: number): Promise<Response> {
    // Param order mirrors the Python dict (subreddit, limit, sort, after, before) — cosmetic, but tidy.
    const params = new URLSearchParams({
      subreddit: this.subreddit,
      limit: String(this.pageLimit),
      sort: 'desc',
      after: String(cutoff),
      before: String(before),
    })
    // Manual timeout so we never leave a dangling timer: unref'd (won't pin the loop) and always cleared.
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error(`timeout after ${this.timeoutMs}ms`)), this.timeoutMs)
    timer.unref?.()
    try {
      return await fetch(`${this.baseUrl}/${kind}/search?${params.toString()}`, {
        method: 'GET',
        headers: { 'User-Agent': this.userAgent },
        signal: ac.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  /** Port of `_respect_ratelimit`: STRICT integer parse of `X-RateLimit-Remaining`; < 50 → back off 2s. */
  private async respectRateLimit(res: Response, sleep: Sleeper): Promise<void> {
    const rem = res.headers.get('x-ratelimit-remaining') // fetch headers are case-insensitive
    if (rem == null) return
    const t = rem.trim()
    // Python `int(rem)` raises ValueError on non-numeric → ignored. `parseInt` would NOT — so gate strictly.
    if (!/^[+-]?\d+$/.test(t)) return
    if (Number(t) < 50) {
      log.info({ remaining: rem }, 'rate-limit low — backing off 2s')
      await sleep(2000)
    }
  }

  /**
   * Walk pages from `now` back to `cutoff`; return the in-window RAW things plus `(capped, ok)`.
   * `ok=false` ⇒ a request errored / returned non-200 / non-JSON mid-walk (partial). `capped` ⇒ the
   * `for…else`: ran every page without a natural stop (genuine overflow, benign).
   */
  private async fetchKind(
    kind: string,
    cutoff: number,
    now: number,
    sleep: Sleeper,
  ): Promise<{ items: RawThing[]; capped: boolean; ok: boolean }> {
    const items: RawThing[] = []
    let before = now + 5 // +5s skew buffer (porting-spec §4)
    let ok = true
    let page = 0
    for (; page < this.maxPages; page++) {
      let res: Response
      try {
        res = await this.get(kind, cutoff, before)
      } catch (e) {
        log.warn({ kind, err: String(e) }, 'page request failed — poll is partial this cycle')
        ok = false
        break
      }
      if (res.status !== 200) {
        const body = await res.text().catch(() => '')
        log.warn({ kind, status: res.status, body: body.slice(0, 140) }, 'page failed — poll is partial this cycle')
        ok = false
        break
      }
      await this.respectRateLimit(res, sleep) // honored BEFORE parsing the body (Python order)
      let data: RawThing[]
      try {
        const json = (await res.json()) as { data?: RawThing[] }
        data = json.data ?? []
      } catch {
        log.warn({ kind }, 'page returned a non-JSON body — poll is partial this cycle')
        ok = false
        break
      }
      if (data.length === 0) break // exhausted
      for (const x of data) items.push(x)
      const oldest = Math.min(...data.map((x) => createdUtcRaw(x, now))) // missing ts ⇒ `now` (won't pull down)
      if (oldest <= cutoff || data.length < this.pageLimit) break // reached window start or short page
      before = oldest
      await sleep(300) // 0.3s inter-page courtesy delay
    }
    // `for…else`: only a clean run of ALL maxPages (no break) is `capped`.
    const capped = page === this.maxPages
    const inWindow = items.filter((x) => createdUtcRaw(x, 0) >= cutoff) // missing ts ⇒ 0 ⇒ excluded
    return { items: inWindow, capped, ok }
  }

  async poll(windowSeconds: number, opts: PollOptions = {}): Promise<PollResult> {
    const now = opts.now ?? Math.floor(Date.now() / 1000)
    const sleep = opts.sleep ?? this.sleep
    const cutoff = now - windowSeconds

    const p = await this.fetchKind('posts', cutoff, now, sleep)
    const c = await this.fetchKind('comments', cutoff, now, sleep)
    const posts = p.items.map((d) => normalizePost(d, now))
    const comments = c.items.map((d) => normalizeComment(d, now))

    const times = [...posts.map((x) => x.createdUtc as number), ...comments.map((x) => x.createdUtc as number)]
    const newestUtc = times.length ? Math.max(...times) : null
    const capped = p.capped || c.capped
    if (capped) {
      log.warn({ maxPages: this.maxPages }, 'hit page cap — window likely undercounted (raise ingest.max_pages)')
    }
    return { posts, comments, newestUtc, capped, ok: p.ok && c.ok }
  }
}
