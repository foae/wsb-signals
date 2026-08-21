import type { MarketMoverInsert } from '@wsb/shared'
import { describe, expect, it } from 'vitest'

import type { EmpiricalFeature } from '../src/aggregate'
import { DEFAULT_MARKET_NORMALIZATION, type MarketData, type StockSnapshot } from '../src/market'
import { overlayMarket } from '../src/pipeline'

// Slice-6 unit: overlayMarket gates to the top-N hot tickers (board order), runs computeAnalytical over
// the returned snapshots, and passes screenerTop through. (computeAnalytical itself is parity-tested in
// slice 5; this checks the gating/wiring.) No DB — pure orchestration with a fake market.

function feat(ticker: string): EmpiricalFeature {
  return {
    ticker, windowStart: 7200, mentions: 1, authors: 1, sov: 0.1, velocity: null, accel: null,
    z: null, netDir: 0, ddCount: 0, flairCounts: {}, baselineStatus: 'cold', hE: 0.1,
  }
}

function snap(ticker: string, price: number, prevClose: number): StockSnapshot {
  return {
    ticker, price, dayOpen: null, dayClose: null, dayVolume: null, prevClose, prevVolume: null,
    feed: 'iex', priceAsOf: 0, volumeAsOf: null,
  }
}

class FakeMarket implements MarketData {
  readonly name = 'fake'
  readonly snapCalls: Array<{ tickers: string[]; now: number }> = []
  readonly screenCalls: Array<{ top: number; now: number }> = []
  constructor(
    private readonly snaps: Map<string, StockSnapshot>,
    private readonly movers: MarketMoverInsert[],
  ) {}
  async snapshots(tickers: readonly string[], now = 0): Promise<Map<string, StockSnapshot>> {
    this.snapCalls.push({ tickers: [...tickers], now })
    return this.snaps
  }
  async screeners(top = 25, now = 0): Promise<MarketMoverInsert[]> {
    this.screenCalls.push({ top, now })
    return this.movers
  }
  async close(): Promise<void> {}
}

describe('overlayMarket gating + wiring', () => {
  it('fetches snapshots for only the top-N tickers (board order) and passes screenerTop through', async () => {
    const rows = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'].map(feat)
    const snaps = new Map([
      ['AAA', snap('AAA', 110, 100)], // ret +0.1
      ['BBB', snap('BBB', 90, 100)], // ret -0.1
    ])
    const movers: MarketMoverInsert[] = [{ ts: 999, kind: 'active', rank: 1, symbol: 'SPY', volume: 1000 }]
    const market = new FakeMarket(snaps, movers)

    const { analytical, movers: out } = await overlayMarket(
      market, 7200, rows, {
        topN: 3, screenerTop: 25, weights: { ret: 0.5, rvol: 0.5 },
        normalization: DEFAULT_MARKET_NORMALIZATION,
      }, 999,
    )

    expect(market.snapCalls).toHaveLength(1)
    expect(market.snapCalls[0]!.tickers).toEqual(['AAA', 'BBB', 'CCC']) // top-3, board order
    expect(market.snapCalls[0]!.now).toBe(999)
    expect(market.screenCalls[0]!.top).toBe(25)

    expect(analytical.map((a) => a.ticker)).toEqual(['AAA', 'BBB']) // snapshot insertion order
    expect(analytical[0]!.ret).toBeCloseTo(0.1, 9)
    expect(analytical[0]!.windowStart).toBe(7200)
    expect(out).toBe(movers)
  })
})
