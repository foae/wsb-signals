/**
 * Alpaca market funnel. Stock snapshots provide current price/volume; cached daily history supplies
 * per-ticker baselines for stable Market Heat (`H_m`). Market scoring is intentionally not normalized
 * against whichever tickers happen to occupy today's top-N WSB list.
 *
 * Snapshot and screener HTTP failures remain best-effort; network errors propagate to the loop's
 * never-kill guard. True source timestamps come from Alpaca's latest trade/minute bar, never fetch time.
 */
import { fetch, type Response } from 'undici'

import type { AnalyticalFeatureInsert, MarketMoverInsert } from '@wsb/shared'

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
  priceAsOf: number | null
  volumeAsOf: number | null
}

/** H_m blend weights (`config.toml [market.weights]`); absent keys default to 0 (Python `w.get(k, 0)`). */
export interface MarketWeights {
  ret?: number
  rvol?: number
  pcr?: number
  iv?: number
}

export interface MarketNormalization {
  retSigmaCap: number
  retVolFloor: number
  rvolCap: number
  minProfileSessions: number
  minSessionMinutes: number
}

export interface MarketProfile {
  dailyVolatility: number | null
  averageVolume: number | null
  sessions: number
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
  /** Cached per-ticker daily baselines for stable radar H_m. Optional implementations fall back to
   *  the snapshot's previous session plus a conservative return-volatility floor. */
  profiles?(tickers: readonly string[], now?: number): Promise<Map<string, MarketProfile>>
  /** Daily bars for ONE symbol over [startUtc, endUtc] — the plays evidence's post-date returns.
   *  Errors propagate; the plays caller degrades because it has no radar cycle to protect. */
  dailyBars?(symbol: string, startUtc: number, endUtc: number): Promise<DailyBar[]>
  close(): Promise<void>
}

// --- H_m scoring ----------------------------------------------------------------------------------

export const DEFAULT_MARKET_NORMALIZATION: MarketNormalization = {
  retSigmaCap: 3,
  retVolFloor: 0.005,
  rvolCap: 3,
  minProfileSessions: 10,
  minSessionMinutes: 30,
}
const EMPTY_PROFILES: ReadonlyMap<string, MarketProfile> = new Map()
const NY_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})
const VOLUME_CURVE: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [30, 0.15], [60, 0.25], [120, 0.40], [180, 0.52],
  [240, 0.65], [300, 0.78], [360, 0.90], [390, 1],
]

function nyParts(epoch: number): { date: string; weekday: string; minute: number } {
  const parts = Object.fromEntries(NY_FORMAT.formatToParts(new Date(epoch * 1000))
    .map((part) => [part.type, part.value]))
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday ?? '',
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  }
}

/** Generic regular-session cumulative-volume curve; null before the open, 1 after the close/weekends. */
export function sessionVolumeFraction(asOf: number, minSessionMinutes = 30): number | null {
  const p = nyParts(asOf)
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return 1
  const elapsed = p.minute - 9 * 60 - 30
  if (elapsed < 0) return null
  if (elapsed >= 390) return 1
  const bounded = Math.max(elapsed, minSessionMinutes)
  for (let i = 1; i < VOLUME_CURVE.length; i++) {
    const [x1, y1] = VOLUME_CURVE[i]!
    if (bounded > x1) continue
    const [x0, y0] = VOLUME_CURVE[i - 1]!
    return y0 + (y1 - y0) * (bounded - x0) / (x1 - x0)
  }
  return 1
}

/** Build a 20-session per-ticker baseline, excluding the current New York session. */
export function buildMarketProfile(
  bars: readonly DailyBar[],
  now: number,
  lookbackSessions = 20,
): MarketProfile {
  const currentDate = nyParts(now).date
  const completed = [...bars]
    .filter((bar) => nyParts(bar.ts).date !== currentDate)
    .sort((a, b) => a.ts - b.ts)
    .slice(-lookbackSessions)
  const closes = completed.flatMap((bar) => bar.close != null && bar.close > 0 ? [bar.close] : [])
  const volumes = completed.flatMap((bar) => bar.volume != null && bar.volume > 0 ? [bar.volume] : [])
  const returns = closes.slice(1).map((close, i) => (close - closes[i]!) / closes[i]!)
  const mean = returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : 0
  const variance = returns.length > 1
    ? returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1)
    : null
  return {
    dailyVolatility: variance == null ? null : Math.sqrt(variance),
    averageVolume: volumes.length ? volumes.reduce((sum, value) => sum + value, 0) / volumes.length : null,
    sessions: Math.min(closes.length, volumes.length),
  }
}

/** Stable per-ticker market heat: volatility-scaled return + session-adjusted relative volume. */
export function computeAnalytical(
  snapshots: Iterable<StockSnapshot>,
  windowStart: number,
  weights: MarketWeights,
  profiles: ReadonlyMap<string, MarketProfile> = EMPTY_PROFILES,
  normalization: MarketNormalization = DEFAULT_MARKET_NORMALIZATION,
): AnalyticalFeatureInsert[] {
  const wRet = Math.max(0, weights.ret ?? 0)
  const wRvol = Math.max(0, weights.rvol ?? 0)

  return [...snapshots].map((s) => {
    const profile = profiles.get(s.ticker)
    const supported = profile != null && profile.sessions >= normalization.minProfileSessions
    const ret = s.price != null && s.prevClose ? (s.price - s.prevClose) / s.prevClose : null
    const retVolBaseline = supported && profile.dailyVolatility != null
      ? Math.max(profile.dailyVolatility, normalization.retVolFloor)
      : normalization.retVolFloor
    const volumeBaseline = supported && profile.averageVolume != null
      ? profile.averageVolume
      : (s.prevVolume || null)
    const volumeFraction = s.volumeAsOf == null
      ? null
      : sessionVolumeFraction(s.volumeAsOf, normalization.minSessionMinutes)
    const rvol = s.dayVolume != null && volumeBaseline && volumeFraction
      ? s.dayVolume / (volumeBaseline * volumeFraction)
      : null
    const retScore = ret != null && s.priceAsOf != null && wRet > 0
      ? Math.min(1, Math.abs(ret) / retVolBaseline / normalization.retSigmaCap)
      : null
    const rvolScore = rvol != null && s.volumeAsOf != null && wRvol > 0
      ? Math.min(1, rvol / normalization.rvolCap)
      : null
    const activeWeight = (retScore == null ? 0 : wRet) + (rvolScore == null ? 0 : wRvol)
    const hM = activeWeight > 0
      ? ((retScore ?? 0) * wRet + (rvolScore ?? 0) * wRvol) / activeWeight
      : null
    const evidenceTimes = [
      ...(retScore != null ? [s.priceAsOf!] : []),
      ...(rvolScore != null ? [s.volumeAsOf!] : []),
    ]
    return {
      ticker: s.ticker,
      windowStart,
      ret,
      rvol,
      rvolConf: s.feed.toLowerCase() === 'iex' ? 'low' : 'high',
      feed: s.feed,
      asOf: evidenceTimes.length ? Math.min(...evidenceTimes) : null,
      retVolBaseline,
      volumeBaseline,
      profileSessions: profile?.sessions ?? 0,
      hM,
    }
  })
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
  latestTrade?: { p?: number; t?: string } | null
  minuteBar?: { t?: string } | null
  dailyBar?: { o?: number; c?: number; v?: number } | null
  prevDailyBar?: { c?: number; v?: number } | null
}

function parseMarketTime(value: string | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

export class AlpacaMarketData implements MarketData {
  readonly name = NAME
  private readonly baseUrl: string
  private readonly feed: string
  private readonly headers: Record<string, string>
  private readonly timeoutMs: number
  private readonly profileCache = new Map<string, { date: string; value: MarketProfile }>()

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
    _now: number = Math.floor(Date.now() / 1000),
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
        const mb = s.minuteBar ?? {}
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
          priceAsOf: parseMarketTime(lt.t),
          volumeAsOf: parseMarketTime(mb.t),
        })
      }
    }
    return out
  }

  async profiles(
    tickers: readonly string[],
    now: number = Math.floor(Date.now() / 1000),
  ): Promise<Map<string, MarketProfile>> {
    const out = new Map<string, MarketProfile>()
    const date = nyParts(now).date
    await Promise.all([...new Set(tickers)].map(async (ticker) => {
      const cached = this.profileCache.get(ticker)
      if (cached?.date === date) {
        out.set(ticker, cached.value)
        return
      }
      try {
        const bars = await this.dailyBars(ticker, now - 70 * 86_400, now)
        const value = buildMarketProfile(bars, now)
        this.profileCache.set(ticker, { date, value })
        out.set(ticker, value)
      } catch (error) {
        log.warn({ ticker, err: String(error) }, 'market profile unavailable')
      }
    }))
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
