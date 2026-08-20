/**
 * Alpaca market funnel — TS port of the frozen v0.0.1 `wsb_signals/market/alpaca.py` +
 * `wsb_signals/analytical.py` (porting-spec §5). The free IEX overlay: per-ticker stock snapshots →
 * `ret`/`rvol` → composite Market Heat `H_m`, plus the market-wide screeners (most-actives + movers).
 *
 * Parity-critical semantics reproduced here:
 *  - snapshots chunk by **100** symbols; a non-200 chunk is WARNED and SKIPPED (best-effort partial) —
 *    other chunks still run. `latestTrade`/`dailyBar`/`prevDailyBar` each default to `{}` (missing field
 *    → null). Insertion order is preserved (a Map), because `compute_analytical` iterates `.values()`.
 *  - screeners: most-actives then movers, each a separate best-effort call; rank is **1-based per kind**
 *    and counts EVERY entry (a symbol-less entry consumes its rank → ranks can have gaps), matching
 *    Python `enumerate(..., 1)` + `if symbol`.
 *  - `compute_analytical`: `ret = (price-prevClose)/prevClose` only when `price != null AND prevClose`
 *    truthy (0/None prevClose → null, the div-by-zero guard); `rvol = dayVolume/prevVolume` likewise;
 *    `|ret|` and `rvol` are max-normed over the hot list (None→0), `H_m = w.ret·|ret|ₙ + w.rvol·rvolₙ`
 *    in that exact op order; `rvolConf` is always `"low"` (thin IEX feed).
 *
 * **Best-effort never-kill lives in the LOOP (slice 6), not here** — exactly as the oracle: `snapshots`/
 * `screeners` swallow non-200s but let a network error PROPAGATE; `cmd_run` wraps the overlay in
 * try/catch so the cycle survives (porting-spec §7). Don't add a network try/catch here — it would move
 * the guard and diverge from the oracle's structure.
 */
import { fetch, type Response } from 'undici'

import type { AnalyticalFeatureInsert, MarketMoverInsert } from '@wsb/shared'

import { maxNorm } from './aggregate'
import { log } from './logger'

const NAME = 'alpaca'

/** A transient point-in-time stock snapshot (mirrors `models.StockSnapshot`); not persisted as-is. */
export interface StockSnapshot {
  ticker: string
  price: number | null
  dayOpen: number | null
  dayClose: number | null
  dayVolume: number | null
  prevClose: number | null
  prevVolume: number | null
  feed: string
  asOf: number
}

/** H_m blend weights (`config.toml [market.weights]`); absent keys default to 0 (Python `w.get(k, 0)`). */
export interface MarketWeights {
  ret?: number
  rvol?: number
  pcr?: number
  iv?: number
}

/** One daily bar (plays evidence, P3). `ts` = bar timestamp, epoch seconds. */
export interface DailyBar {
  ts: number
  close: number | null
  volume: number | null
}

export interface MarketData {
  readonly name: string
  snapshots(tickers: readonly string[], now?: number): Promise<Map<string, StockSnapshot>>
  screeners(top?: number, now?: number): Promise<MarketMoverInsert[]>
  /** Daily bars for ONE symbol over [startUtc, endUtc] — the plays evidence's post-date returns
   *  (P3; P5 grows this interface further with calendar + option snapshots). OPTIONAL so radar-only
   *  fakes/impls stay untouched; evidence degrades to "unavailable" without it. Unlike the radar
   *  methods above, errors PROPAGATE — the plays caller degrades, it has no cycle to protect. */
  dailyBars?(symbol: string, startUtc: number, endUtc: number): Promise<DailyBar[]>
  close(): Promise<void>
}

// --- H_m scoring (pure — `analytical.compute_analytical`) -------------------------------------------

/**
 * Compute the analytical (market) features + `H_m` over the hot-list snapshots. Pure; the B4 market
 * parity target. Iterates snapshots in insertion order (`.values()`), so callers must preserve order.
 */
export function computeAnalytical(
  snapshots: Iterable<StockSnapshot>,
  windowStart: number,
  weights: MarketWeights,
): AnalyticalFeatureInsert[] {
  const items = [...snapshots]
  // `prevClose`/`prevVolume` use TRUTHINESS (0 or null → null) — the div-by-zero guard; `price`/
  // `dayVolume` use an explicit null check (a genuine 0 is a valid numerator).
  const rets = items.map((s) => (s.price != null && s.prevClose ? (s.price - s.prevClose) / s.prevClose : null))
  const rvols = items.map((s) => (s.dayVolume != null && s.prevVolume ? s.dayVolume / s.prevVolume : null))

  const absretN = maxNorm(rets.map((r) => (r != null ? Math.abs(r) : 0)))
  const rvolN = maxNorm(rvols.map((v) => (v != null ? v : 0)))
  const wRet = weights.ret ?? 0
  const wRvol = weights.rvol ?? 0

  return items.map((s, i) => ({
    ticker: s.ticker,
    windowStart,
    ret: rets[i]!,
    rvol: rvols[i]!,
    rvolConf: 'low',
    hM: wRet * absretN[i]! + wRvol * rvolN[i]!,
  }))
}

// --- the client ------------------------------------------------------------------------------------

export interface AlpacaOptions {
  dataUrl?: string
  feed?: string
  userAgent?: string
  timeoutMs?: number
}

/** Raw snapshot shape from `/v2/stocks/snapshots` (only the fields the overlay reads). */
interface RawSnap {
  latestTrade?: { p?: number } | null
  dailyBar?: { o?: number; c?: number; v?: number } | null
  prevDailyBar?: { c?: number; v?: number } | null
}

export class AlpacaMarketData implements MarketData {
  readonly name = NAME
  private readonly baseUrl: string
  private readonly feed: string
  private readonly headers: Record<string, string>
  private readonly timeoutMs: number

  constructor(key: string, secret: string, opts: AlpacaOptions = {}) {
    this.baseUrl = (opts.dataUrl ?? 'https://data.alpaca.markets').replace(/\/+$/, '')
    this.feed = opts.feed ?? 'iex'
    this.headers = {
      'APCA-API-KEY-ID': key,
      'APCA-API-SECRET-KEY': secret,
      'User-Agent': opts.userAgent ?? 'wsb-signals/0.0.1',
    }
    this.timeoutMs = opts.timeoutMs ?? 30_000
  }

  /** No persistent client to release (undici global dispatcher) — a no-op for interface symmetry. */
  async close(): Promise<void> {}

  private async get(path: string, params: Record<string, string>): Promise<Response> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error(`timeout after ${this.timeoutMs}ms`)), this.timeoutMs)
    timer.unref?.()
    try {
      const res = await fetch(`${this.baseUrl}${path}?${new URLSearchParams(params).toString()}`, {
        method: 'GET',
        headers: this.headers,
        signal: ac.signal,
      })
      // Greppable rate-limit line (matches ingest.ts/media.ts) so request volume can be tuned; the
      // caller still sees and handles the 429 as before.
      if (res.status === 429) {
        log.warn({
          path,
          retryAfter: res.headers.get('retry-after'),
          remaining: res.headers.get('x-ratelimit-remaining'),
          reset: res.headers.get('x-ratelimit-reset'),
        }, 'API rate limit hit — Alpaca throttled this request')
      }
      return res
    } finally {
      clearTimeout(timer)
    }
  }

  async snapshots(
    tickers: readonly string[],
    now: number = Math.floor(Date.now() / 1000),
  ): Promise<Map<string, StockSnapshot>> {
    const out = new Map<string, StockSnapshot>()
    if (tickers.length === 0) return out // no symbols → no call (Python early return)
    for (let i = 0; i < tickers.length; i += 100) {
      const chunk = tickers.slice(i, i + 100)
      const r = await this.get('/v2/stocks/snapshots', { symbols: chunk.join(','), feed: this.feed })
      if (r.status !== 200) {
        const body = await r.text().catch(() => '')
        log.warn({ status: r.status, body: body.slice(0, 140) }, 'snapshots failed')
        continue // best-effort: skip this chunk, keep going
      }
      const json = (await r.json()) as Record<string, RawSnap>
      for (const [sym, s] of Object.entries(json)) {
        const lt = s.latestTrade ?? {}
        const db = s.dailyBar ?? {}
        const pdb = s.prevDailyBar ?? {}
        out.set(sym, {
          ticker: sym,
          price: lt.p ?? null,
          dayOpen: db.o ?? null,
          dayClose: db.c ?? null,
          dayVolume: db.v ?? null,
          prevClose: pdb.c ?? null,
          prevVolume: pdb.v ?? null,
          feed: this.feed,
          asOf: now,
        })
      }
    }
    return out
  }

  /** Plays-evidence daily bars (P3) — one symbol, `/v2/stocks/{symbol}/bars` timeframe=1Day. A
   *  non-200 THROWS (unlike the best-effort radar calls above): the plays caller catches and
   *  degrades its evidence; swallowing here would silently blank it. */
  async dailyBars(symbol: string, startUtc: number, endUtc: number): Promise<DailyBar[]> {
    const r = await this.get(`/v2/stocks/${encodeURIComponent(symbol)}/bars`, {
      timeframe: '1Day',
      start: new Date(startUtc * 1000).toISOString(),
      end: new Date(Math.min(endUtc, Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      limit: '50',
      feed: this.feed,
      adjustment: 'split', // a raw close across a split would fabricate a huge phantom day return
    })
    if (r.status !== 200) {
      const body = await r.text().catch(() => '')
      throw new Error(`alpaca daily bars ${symbol}: status ${r.status} ${body.slice(0, 140)}`)
    }
    const j = (await r.json()) as { bars?: Array<{ t?: string; c?: number; v?: number }> | null }
    return (j.bars ?? []).flatMap((b) => {
      const ts = b.t ? Date.parse(b.t) / 1000 : NaN
      return Number.isNaN(ts) ? [] : [{ ts, close: b.c ?? null, volume: b.v ?? null }]
    })
  }

  async screeners(top = 25, now: number = Math.floor(Date.now() / 1000)): Promise<MarketMoverInsert[]> {
    const movers: MarketMoverInsert[] = []

    const ra = await this.get('/v1beta1/screener/stocks/most-actives', { top: String(top) })
    if (ra.status === 200) {
      const j = (await ra.json()) as { most_actives?: Array<{ symbol?: string; volume?: number }> }
      let rank = 0
      for (const a of j.most_actives ?? []) {
        rank++ // 1-based, counts EVERY entry (symbol-less ones consume their rank → gaps)
        if (a.symbol) movers.push({ ts: now, kind: 'active', rank, symbol: a.symbol, volume: a.volume ?? null })
      }
    } else {
      const body = await ra.text().catch(() => '')
      log.warn({ status: ra.status, body: body.slice(0, 120) }, 'most-actives failed')
    }

    const rm = await this.get('/v1beta1/screener/stocks/movers', { top: String(top) })
    if (rm.status === 200) {
      const d = (await rm.json()) as {
        gainers?: Array<{ symbol?: string; price?: number; percent_change?: number }>
        losers?: Array<{ symbol?: string; price?: number; percent_change?: number }>
      }
      for (const [kind, key] of [['gainer', 'gainers'], ['loser', 'losers']] as const) {
        let rank = 0 // rank restarts per kind
        for (const m of d[key] ?? []) {
          rank++
          if (m.symbol) {
            movers.push({
              ts: now, kind, rank, symbol: m.symbol,
              price: m.price ?? null, percentChange: m.percent_change ?? null,
            })
          }
        }
      }
    } else {
      const body = await rm.text().catch(() => '')
      log.warn({ status: rm.status, body: body.slice(0, 120) }, 'movers failed')
    }

    return movers
  }
}
