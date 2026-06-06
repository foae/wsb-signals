import { readFileSync } from 'node:fs'

import type { MarketMoverInsert } from '@wsb/shared'
import { describe, expect, it } from 'vitest'

import { AlpacaMarketData, computeAnalytical, type StockSnapshot } from '../src/market'
import { startMockAlpaca, type AlpacaCassette } from './helpers/mockAlpaca'

// Slice-5 parity gate (porting-spec §5): the ported Alpaca funnel must reproduce the frozen v0.0.1
// oracle EXACTLY —
//   * analytical : computeAnalytical(snapshots) → AnalyticalFeature[] + H_m (ret/rvol guards, abs-ret
//                  max-norm, blend) over hand snapshots;
//   * snapshots  : the SAME chunk cassette replayed through a mock server — chunk-100, non-200 skip,
//                  field parsing, insertion-order preservation;
//   * screeners  : 1-based-per-kind rank with symbol-less gaps, per-call best-effort.

type Snake = Record<string, any>

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
    feed: s.feed, asOf: s.as_of,
  }
}

describe('market analytical H_m parity (B4)', () => {
  it.each(['mixed', 'weights_variant', 'all_null'])('computeAnalytical %s matches the oracle', (name) => {
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
      expectCloseOrNull(a.hM, exp.h_m, `${at}.hM`)
    })
  })
})

function expectSnap(actual: StockSnapshot, exp: Snake, now: number): void {
  expect(actual.price ?? null).toBe(exp.price ?? null)
  expect(actual.dayOpen ?? null).toBe(exp.day_open ?? null)
  expect(actual.dayClose ?? null).toBe(exp.day_close ?? null)
  expect(actual.dayVolume ?? null).toBe(exp.day_volume ?? null)
  expect(actual.prevClose ?? null).toBe(exp.prev_close ?? null)
  expect(actual.prevVolume ?? null).toBe(exp.prev_volume ?? null)
  expect(actual.feed).toBe(exp.feed)
  expect(actual.asOf).toBe(now)
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
        expectSnap(snaps.get(sym)!, exp, fx.now)
      }
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
