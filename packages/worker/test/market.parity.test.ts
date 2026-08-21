import { readFileSync } from 'node:fs'

import type { MarketMoverInsert } from '@wsb/shared'
import { describe, expect, it } from 'vitest'

import {
  AlpacaMarketData, buildMarketProfile, computeAnalytical, sessionVolumeFraction,
  type DailyBar, type StockSnapshot,
} from '../src/market'
import { startMockAlpaca, type AlpacaCassette } from './helpers/mockAlpaca'

// Snapshot/screener transport remains pinned to the frozen oracle. H_m deliberately diverges: it is now
// per-ticker, volatility-scaled, and session-adjusted rather than max-normalized against the live top-N.

type Snake = Record<string, any>
const NOW = 1_787_259_600

const load = (rel: string): any =>
  JSON.parse(readFileSync(new URL(`../../../fixtures/${rel}`, import.meta.url), 'utf8'))

function expectCloseOrNull(actual: number | null | undefined, expected: number | null, label: string): void {
  if (expected === null) expect(actual ?? null, label).toBeNull()
  else {
    expect(actual ?? null, label).not.toBeNull()
    expect(actual as number, label).toBeCloseTo(expected, 9)
  }
}

/** StockSnapshot.model_dump (snake) → the TS camelCase StockSnapshot the function consumes. */
function snapFromSnake(s: Snake): StockSnapshot {
  return {
    ticker: s.ticker, price: s.price, dayOpen: s.day_open, dayClose: s.day_close,
    dayVolume: s.day_volume, prevClose: s.prev_close, prevVolume: s.prev_volume,
    feed: s.feed, priceAsOf: s.as_of, volumeAsOf: s.as_of,
  }
}

describe('market analytical feature contract', () => {
  it.each(['mixed', 'weights_variant', 'all_null'])('computeAnalytical %s matches its contract', (name) => {
    const fx = load(`market/analytical/${name}.json`)
    const out = computeAnalytical(fx.snapshots.map(snapFromSnake), fx.window_start, fx.weights)

    expect(out.map((a) => a.ticker)).toEqual(fx.features.map((f: Snake) => f.ticker))
    fx.features.forEach((exp: Snake, i: number) => {
      const a = out[i]!
      const at = `${name}[${i}] ${exp.ticker}`
      expect(a.ticker, `${at}.ticker`).toBe(exp.ticker)
      expect(a.windowStart, `${at}.windowStart`).toBe(exp.window_start)
      expect(a.rvolConf, `${at}.rvolConf`).toBe(exp.rvol_conf)
      expectCloseOrNull(a.ret, exp.ret, `${at}.ret`)
      expectCloseOrNull(a.rvol, exp.rvol, `${at}.rvol`)
      if (a.hM == null) expect(a.asOf, `${at}.missing evidence timestamp`).toBeNull()
      else {
        expect(a.asOf, `${at}.evidence timestamp`).not.toBeNull()
        expect(a.hM, `${at}.hM`).toBeGreaterThanOrEqual(0)
        expect(a.hM, `${at}.hM`).toBeLessThanOrEqual(1)
      }
    })
  })

  it('keeps one ticker H_m stable when unrelated hot-list members change', () => {
    const asOf = Date.parse('2026-08-20T15:00:00Z') / 1000
    const a: StockSnapshot = {
      ticker: 'A', price: 103, prevClose: 100, dayOpen: 100, dayClose: 102,
      dayVolume: 400, prevVolume: 1000, feed: 'iex', priceAsOf: asOf, volumeAsOf: asOf,
    }
    const extreme: StockSnapshot = {
      ticker: 'EXTREME', price: 200, prevClose: 100, dayOpen: 100, dayClose: 200,
      dayVolume: 10_000, prevVolume: 1000, feed: 'iex', priceAsOf: asOf, volumeAsOf: asOf,
    }
    const profiles = new Map([
      ['A', { dailyVolatility: 0.02, averageVolume: 1000, sessions: 20 }],
      ['EXTREME', { dailyVolatility: 0.02, averageVolume: 1000, sessions: 20 }],
    ])
    const aloneRow = computeAnalytical([a], NOW, { ret: 0.5, rvol: 0.5 }, profiles)[0]!
    const alone = aloneRow.hM
    const expectedRvol = 400 / (1000 * 0.325) // 11:00 ET, 90 minutes into the session
    const expectedHm = (0.5 + Math.min(1, expectedRvol / 3)) / 2
    expect(aloneRow.rvol).toBeCloseTo(expectedRvol, 12)
    expect(alone).toBeCloseTo(expectedHm, 12)
    const together = computeAnalytical([a, extreme], NOW, { ret: 0.5, rvol: 0.5 }, profiles)[0]!.hM
    expect(together).toBeCloseTo(alone!, 12)
  })

  it('withholds H_m without timestamped evidence while retaining raw observations', () => {
    const row = computeAnalytical([{
      ticker: 'A', price: 103, prevClose: 100, dayOpen: 100, dayClose: 102,
      dayVolume: 400, prevVolume: 1000, feed: 'sip', priceAsOf: null, volumeAsOf: null,
    }], NOW, { ret: 0.5, rvol: 0.5 })[0]!
    expect(row.ret).toBeCloseTo(0.03, 12)
    expect(row.hM).toBeNull()
    expect(row.asOf).toBeNull()
    expect(row.rvolConf).toBe('high')
  })

  it('builds trailing profiles and adjusts cumulative volume for session progress', () => {
    const now = Date.parse('2026-08-21T16:00:00Z') / 1000
    const bars: DailyBar[] = Array.from({ length: 21 }, (_, i) => ({
      ts: now - (21 - i) * 86_400,
      close: 100 + i,
      volume: 1000 + i * 10,
    }))
    const profile = buildMarketProfile(bars, now, 20)
    expect(profile.sessions).toBe(20)
    expect(profile.dailyVolatility).toBeGreaterThan(0)
    expect(profile.averageVolume).toBeGreaterThan(1000)
    expect(sessionVolumeFraction(Date.parse('2026-08-20T14:00:00Z') / 1000)).toBeCloseTo(0.15, 9)
    expect(sessionVolumeFraction(Date.parse('2026-08-20T20:00:00Z') / 1000)).toBe(1)
  })
})

function expectSnap(actual: StockSnapshot, exp: Snake): void {
  expect(actual.price ?? null).toBe(exp.price ?? null)
  expect(actual.dayOpen ?? null).toBe(exp.day_open ?? null)
  expect(actual.dayClose ?? null).toBe(exp.day_close ?? null)
  expect(actual.dayVolume ?? null).toBe(exp.day_volume ?? null)
  expect(actual.prevClose ?? null).toBe(exp.prev_close ?? null)
  expect(actual.prevVolume ?? null).toBe(exp.prev_volume ?? null)
  expect(actual.feed).toBe(exp.feed)
  expect(actual.priceAsOf).toBeNull()
  expect(actual.volumeAsOf).toBeNull()
}

describe('market snapshots parity (cassette dual-run)', () => {
  it.each(['single_chunk', 'two_chunks', 'chunk_non200_skipped'])('snapshots %s matches the oracle', async (name) => {
    const fx = load(`market/snapshots/${name}.json`)
    const mock = await startMockAlpaca(fx.cassette as AlpacaCassette)
    try {
      const client = new AlpacaMarketData('KEY', 'SECRET', { dataUrl: mock.baseUrl })
      const snaps = await client.snapshots(fx.tickers, fx.now)

      const snapReqs = mock.requests.filter((r) => r.path.includes('/snapshots')).length
      expect(snapReqs, `${name}.request_count`).toBe(fx.request_count)
      // .values() order is part of the contract (compute_analytical iterates it) → assert key order.
      expect([...snaps.keys()], `${name}.order`).toEqual(Object.keys(fx.expected))
      for (const [sym, exp] of Object.entries(fx.expected as Record<string, Snake>)) {
        expectSnap(snaps.get(sym)!, exp)
      }
    } finally {
      await mock.close()
    }
  })
})

describe('market observation provenance', () => {
  it('uses Alpaca observation timestamps rather than HTTP fetch time', async () => {
    const priceTime = '2026-08-20T19:59:00Z'
    const volumeTime = '2026-08-20T20:00:00Z'
    const mock = await startMockAlpaca({ snapshots: [{ json: {
      NVDA: {
        latestTrade: { p: 180, t: priceTime },
        dailyBar: { o: 175, c: 179, v: 200, t: volumeTime },
        prevDailyBar: { c: 170, v: 100 },
        minuteBar: { t: volumeTime },
      },
    } }] })
    try {
      const client = new AlpacaMarketData('KEY', 'SECRET', { dataUrl: mock.baseUrl })
      const snap = (await client.snapshots(['NVDA'], NOW)).get('NVDA')!
      expect(snap.priceAsOf).toBe(Date.parse(priceTime) / 1000)
      expect(snap.volumeAsOf).toBe(Date.parse(volumeTime) / 1000)
      expect(computeAnalytical([snap], NOW, { ret: 0.5, rvol: 0.5 })[0]!.asOf)
        .toBe(Date.parse(priceTime) / 1000)
    } finally {
      await mock.close()
    }
  })
})

function expectMover(actual: MarketMoverInsert, exp: Snake, now: number): void {
  expect(actual.symbol).toBe(exp.symbol)
  expect(actual.kind).toBe(exp.kind)
  expect(actual.rank).toBe(exp.rank)
  expect(actual.ts).toBe(now)
  expect(actual.price ?? null).toBe(exp.price ?? null)
  expect(actual.percentChange ?? null).toBe(exp.percent_change ?? null)
  expect(actual.volume ?? null).toBe(exp.volume ?? null)
}

describe('market screeners parity (cassette dual-run)', () => {
  it.each(['happy', 'symbolless_gap', 'actives_fail_movers_ok'])('screeners %s matches the oracle', async (name) => {
    const fx = load(`market/screeners/${name}.json`)
    const mock = await startMockAlpaca(fx.cassette as AlpacaCassette)
    try {
      const client = new AlpacaMarketData('KEY', 'SECRET', { dataUrl: mock.baseUrl })
      const movers = await client.screeners(fx.top, fx.now)

      expect(movers.map((m) => [m.kind, m.rank, m.symbol]), `${name}.shape`)
        .toEqual(fx.expected.map((m: Snake) => [m.kind, m.rank, m.symbol]))
      fx.expected.forEach((exp: Snake, i: number) => expectMover(movers[i]!, exp, fx.now))
    } finally {
      await mock.close()
    }
  })
})
