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
 *
 * DELIBERATE DIVERGENCE from the oracle's §4 contract (gate-safe — porting-spec §4): the oracle gives up
 * the whole poll on the FIRST transient page failure. Live, the heavy 1h comment backfill reliably trips
 * Arctic-Shift's `422 "Timeout. Maybe slow down a bit"` throttle and intermittent 5xx, so a no-retry
 * client discards most cycles (board gaps). So a transient page failure (throttle / 5xx / network /
 * non-JSON) is RETRIED with bounded exponential backoff before declaring `ok=false`; a genuine
 * non-retryable 4xx (400/401/403/404…) still fails immediately. This is upstream of the parity
 * boundary — retries change WHICH poll succeeds, never how a captured poll is scored — so it does not
 * affect scoring parity. Disable (`maxRetries: 0`) to get the exact oracle no-retry semantics (the
 * parity test does).
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

/** A raw thing as it arrives from Arctic-Shift — snake_case Reddit keys, untyped values. Exported for
 *  the plays capture, which reads the FULL dict (~110 keys: permalink, is_gallery, media_metadata, …)
 *  that the normalized parity rows deliberately drop (plays-plan §3). */
export type RawThing = Record<string, unknown>

export interface PollResult {
  posts: RawPostInsert[]
  comments: RawCommentInsert[]
  /** The in-window posts as FULL raw dicts, for the plays capture. The Source seam stays
   *  plays-agnostic: flair filtering happens in plays/capture.ts, never here (plays-plan §3). */
  rawPosts: RawThing[]
  newestUtc: number | null // freshest normalized item seen — feeds the heartbeat
  capped: boolean // pagination hit the page cap (window undercounted, but benign)
  ok: boolean // false if a fetch errored mid-pagination (partial — caller discards whole)
  /** The posts-side walk alone succeeded. Plays capture keys on THIS, not `ok`: the whole-poll discard
   *  protects the SoV denominator, which capture doesn't touch — a prolonged comments-side failure must
   *  not lose a window of plays whose media is meanwhile being deleted (plays-plan §3). */
  postsOk: boolean
}

export interface PollOptions {
  /** Injected wall clock (epoch seconds). Defaults to `Math.floor(Date.now()/1000)` — the Python `now`. */
  now?: number
  /** Override the inter-page / rate-limit backoff (tests pass a recording no-op to avoid real waits). */
  sleep?: Sleeper
  /** External abort (e.g. SIGTERM) — cuts an in-flight fetch short so shutdown doesn't wait out a poll. */
  signal?: AbortSignal
}

export interface Source {
  readonly name: string
  poll(windowSeconds: number, opts?: PollOptions): Promise<PollResult>
  close(): Promise<void>
}

/** Injectable so tests record/zero the inter-page (0.3s) and rate-limit (2s) backoffs without real waits. */
export type Sleeper = (ms: number) => Promise<void>
const realSleep: Sleeper = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * HTTP statuses worth retrying (transient/server-side), per the DELIBERATE DIVERGENCE above. `422` is here
 * because Arctic-Shift returns it as its THROTTLE signal ("Timeout. Maybe slow down a bit"), not as a
 * genuine Unprocessable-Entity — and this client's query is fixed/templated, so a "real" 422 never occurs.
 * Excludes the mock's off-the-end sentinel (598) and genuine client errors (400/401/403/404), which fail fast.
 */
const RETRYABLE_STATUS = new Set([408, 422, 425, 429, 500, 502, 503, 504])
/** Cap on the exponential retry backoff — bounds the worst-case shutdown delay during a backoff sleep. */
const RETRY_BACKOFF_CAP_MS = 5000

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
  /** Retries for a transient page failure before discarding the poll (0 = oracle-exact no-retry). Default 3. */
  maxRetries?: number
  /** Base exponential backoff between retries (1s → 2s → 4s …, capped at RETRY_BACKOFF_CAP_MS). Default 1000. */
  retryBackoffMs?: number
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
  private readonly maxRetries: number
  private readonly retryBackoffMs: number

  constructor(baseUrl: string, subreddit: string, opts: ArcticShiftOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '') // Python `base_url.rstrip("/")`
    this.subreddit = subreddit
    this.pageLimit = opts.pageLimit ?? 100
    this.maxPages = opts.maxPages ?? 60
    this.userAgent = opts.userAgent ?? 'wsb-signals/0.0.1'
    this.timeoutMs = opts.timeoutMs ?? 60_000
    this.sleep = opts.sleep ?? realSleep
    this.maxRetries = opts.maxRetries ?? 3
    this.retryBackoffMs = opts.retryBackoffMs ?? 1000
  }

  /** undici `fetch` holds no per-client connection to release (global dispatcher) — a no-op for symmetry. */
  async close(): Promise<void> {}

  private async get(kind: string, cutoff: number, before: number, external?: AbortSignal): Promise<Response> {
    // Param order mirrors the Python dict (subreddit, limit, sort, after, before) — cosmetic, but tidy.
    const params = new URLSearchParams({
      subreddit: this.subreddit,
      limit: String(this.pageLimit),
      sort: 'desc',
      after: String(cutoff),
      before: String(before),
    })
    // Manual timeout so we never leave a dangling timer: unref'd (won't pin the loop) and always cleared.
    // Combined with the external (shutdown) signal so SIGTERM aborts an in-flight fetch.
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error(`timeout after ${this.timeoutMs}ms`)), this.timeoutMs)
    timer.unref?.()
    const signal = external ? AbortSignal.any([ac.signal, external]) : ac.signal
    try {
      return await fetch(`${this.baseUrl}/${kind}/search?${params.toString()}`, {
        method: 'GET',
        headers: { 'User-Agent': this.userAgent },
        signal,
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
   * Fetch ONE page (cursor `before`), retrying transient failures (throttle / 5xx / network / non-JSON)
   * with bounded exponential backoff per the DELIBERATE DIVERGENCE in the file header. Returns the page's
   * `data` on success, or `{ ok: false }` once a non-retryable failure occurs or retries are exhausted.
   * The rate-limit courtesy backoff is honored on a 200 BEFORE the body is parsed (Python order), so the
   * §4 timing parity holds. A shutdown abort (external signal) is NEVER retried — it bails immediately.
   */
  private async fetchPage(
    kind: string,
    cutoff: number,
    before: number,
    sleep: Sleeper,
    signal?: AbortSignal,
  ): Promise<{ ok: true; data: RawThing[] } | { ok: false }> {
    for (let attempt = 0; ; attempt++) {
      let retryable = false
      let detail = ''
      try {
        const res = await this.get(kind, cutoff, before, signal)
        if (res.status === 200) {
          await this.respectRateLimit(res, sleep) // honored BEFORE parsing the body (Python order)
          try {
            const json = (await res.json()) as { data?: RawThing[] }
            return { ok: true, data: json.data ?? [] }
          } catch {
            retryable = true // a 200 with a non-JSON body (e.g. a Cloudflare interstitial) — likely transient
            detail = 'non-JSON body'
          }
        } else {
          const body = await res.text().catch(() => '')
          retryable = RETRYABLE_STATUS.has(res.status)
          detail = `status ${res.status} ${body.slice(0, 140)}`.trim()
          // Rate-limit hits get their OWN greppable line (beyond the generic retry warn below) so the
          // request cadence can be tuned against real data — Arctic-Shift throttles as 422 "slow down",
          // standard APIs as 429. This is a free service; every one of these lines is us over-asking.
          if (res.status === 429 || res.status === 422) {
            log.warn({
              kind, status: res.status,
              retryAfter: res.headers.get('retry-after'),
              remaining: res.headers.get('x-ratelimit-remaining'),
              reset: res.headers.get('x-ratelimit-reset'),
            }, 'API rate limit hit — Arctic-Shift throttled this request')
          }
        }
      } catch (e) {
        // A shutdown (external abort) must NOT be retried — it's an intentional stop, not a transient fault.
        if (signal?.aborted) {
          log.warn({ kind }, 'poll aborted (shutdown) mid-fetch — partial this cycle')
          return { ok: false }
        }
        retryable = true // network error / request timeout — transient
        detail = String(e)
      }

      if (!retryable || attempt >= this.maxRetries) {
        log.warn({ kind, attempt, detail }, 'page failed — poll is partial this cycle')
        return { ok: false }
      }
      const backoff = Math.min(this.retryBackoffMs * 2 ** attempt, RETRY_BACKOFF_CAP_MS)
      log.warn({ kind, attempt: attempt + 1, maxRetries: this.maxRetries, backoffMs: backoff, detail },
        'transient page failure — backing off then retrying (Arctic-Shift throttle/5xx/network)')
      await sleep(backoff)
      if (signal?.aborted) return { ok: false } // shutdown requested during the backoff
    }
  }

  /**
   * Walk pages from `now` back to `cutoff`; return the in-window RAW things plus `(capped, ok)`.
   * `ok=false` ⇒ a page failed and retries (if any) couldn't recover it mid-walk (partial). `capped` ⇒ the
   * `for…else`: ran every page without a natural stop (genuine overflow, benign).
   */
  private async fetchKind(
    kind: string,
    cutoff: number,
    now: number,
    sleep: Sleeper,
    signal?: AbortSignal,
  ): Promise<{ items: RawThing[]; capped: boolean; ok: boolean }> {
    const items: RawThing[] = []
    let before = now + 5 // +5s skew buffer (porting-spec §4)
    let ok = true
    let page = 0
    for (; page < this.maxPages; page++) {
      const r = await this.fetchPage(kind, cutoff, before, sleep, signal)
      if (!r.ok) {
        ok = false
        break
      }
      const data = r.data
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

  /**
   * Seconds between `now` and the freshest archived item of `kind` ('comments'|'posts') — the heartbeat
   * probe (port of arctic_shift.newest_item_lag). null if the tap errors, returns non-200, or is empty.
   *
   * Minor hardening vs Python: network errors (fetch throws) are ALSO caught → null, which the healthcheck
   * treats as NO-DATA. Python only handles non-200 status; we treat a throw identically.
   */
  async newestItemLag(kind: string, now?: number): Promise<number | null> {
    const params = new URLSearchParams({
      subreddit: this.subreddit,
      limit: '1',
      sort: 'desc',
    })
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error(`timeout after ${this.timeoutMs}ms`)), this.timeoutMs)
    timer.unref?.()
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/${kind}/search?${params.toString()}`, {
        method: 'GET',
        headers: { 'User-Agent': this.userAgent },
        signal: ac.signal,
      })
    } catch (e) {
      // Network error (also timeout) — Python's newest_item_lag doesn't catch these, but treating
      // them as null (NO-DATA) is correct: a connection failure means the tap is unreachable.
      log.warn({ kind, err: String(e) }, `heartbeat ${kind} probe failed (network error)`)
      clearTimeout(timer)
      return null
    } finally {
      clearTimeout(timer)
    }
    if (res.status !== 200) {
      log.warn({ kind, status: res.status }, `heartbeat ${kind} probe failed`)
      return null
    }
    let data: RawThing[]
    try {
      const json = (await res.json()) as { data?: RawThing[] }
      data = json.data ?? []
    } catch {
      log.warn({ kind }, `heartbeat ${kind} probe returned non-JSON body`)
      return null
    }
    if (data.length === 0) return null
    const newest = Math.max(...data.map((x) => Number(x.created_utc ?? 0)))
    const nowSec = now ?? Math.floor(Date.now() / 1000)
    return nowSec - newest
  }

  async poll(windowSeconds: number, opts: PollOptions = {}): Promise<PollResult> {
    const now = opts.now ?? Math.floor(Date.now() / 1000)
    const sleep = opts.sleep ?? this.sleep
    const cutoff = now - windowSeconds

    const p = await this.fetchKind('posts', cutoff, now, sleep, opts.signal)
    const c = await this.fetchKind('comments', cutoff, now, sleep, opts.signal)
    const posts = p.items.map((d) => normalizePost(d, now))
    const comments = c.items.map((d) => normalizeComment(d, now))

    const times = [...posts.map((x) => x.createdUtc as number), ...comments.map((x) => x.createdUtc as number)]
    const newestUtc = times.length ? Math.max(...times) : null
    const capped = p.capped || c.capped
    if (capped) {
      log.warn({ maxPages: this.maxPages }, 'hit page cap — window likely undercounted (raise ingest.max_pages)')
    }
    return { posts, comments, rawPosts: p.items, newestUtc, capped, ok: p.ok && c.ok, postsOk: p.ok }
  }
}
