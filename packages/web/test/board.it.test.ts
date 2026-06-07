/**
 * Web read-path integration test (slice 8) on real Postgres. Pins the read CONTRACT the SSR board relies
 * on (porting-spec §6/§11; the review-gate findings):
 *  - latest COMPLETE window only — a non-'complete' (half-written) later cycle is NEVER served;
 *  - canonical board order (h_e→sov→authors→mentions→ticker) reproduced by the JS `compareBoard` sort;
 *  - LEFT-join tolerance — non-overlaid tickers (no signals/analytical) stay on the board with null cols;
 *  - H_m/divergence/quadrant come from `signals` (publish-time effective), ret/rvol from analytical;
 *  - prettyName applied to names; movers come from the latest screener capture only.
 */
import { analyticalFeatures, cycleRuns, empiricalFeatures, marketMovers, signals, tickerNames } from '@wsb/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { readBoard } from '../server/utils/board'
import { startPg, type PgHarness } from './helpers/pg'

let pg: PgHarness
beforeAll(async () => { pg = await startPg() }, 120_000)
afterAll(async () => { await pg?.stop() })
beforeEach(async () => { await pg.reset() })

const W = 1_704_067_200 // 2024-01-01 00:00 UTC

/** Seed the canonical "ok" cycle: 4 tickers exercising ordering, tie-break, and LEFT-join tolerance. */
async function seedOkCycle(): Promise<void> {
  await pg.db.insert(cycleRuns).values({
    windowStart: W, generatedAt: W + 300, totalMentions: 120, quiet: false, capped: false,
    newestUtc: W + 120, status: 'complete',
  })
  await pg.db.insert(empiricalFeatures).values([
    { ticker: 'AAA', windowStart: W, mentions: 30, authors: 9, sov: 0.5, netDir: 0.4, ddCount: 2, baselineStatus: 'ready', hE: 0.9 },
    { ticker: 'BBB', windowStart: W, mentions: 20, authors: 7, sov: 0.3, netDir: 0.1, ddCount: 0, baselineStatus: 'warming', hE: 0.6 },
    // CCC and DDD are identical except ticker → ticker-asc tie-break must put CCC before DDD
    { ticker: 'CCC', windowStart: W, mentions: 10, authors: 5, sov: 0.2, netDir: 0, ddCount: 0, baselineStatus: 'cold', hE: 0.4 },
    { ticker: 'DDD', windowStart: W, mentions: 10, authors: 5, sov: 0.2, netDir: 0, ddCount: 0, baselineStatus: 'cold', hE: 0.4 },
  ])
  // signals: AAA + BBB overlaid (h_m/quadrant set); CCC carries a row with NULL market cols; DDD has NO row.
  await pg.db.insert(signals).values([
    { ticker: 'AAA', windowStart: W, hE: 0.9, hM: 0.8, divergence: 0.1, quadrant: 'CONFIRMED', rank: 1, rankDelta: 2 },
    { ticker: 'BBB', windowStart: W, hE: 0.6, hM: 0.2, divergence: 0.4, quadrant: 'HYPE', rank: 2, rankDelta: -1 },
    { ticker: 'CCC', windowStart: W, hE: 0.4, hM: null, divergence: null, quadrant: null, rank: 3, rankDelta: null },
  ])
  // analytical: AAA only. BBB is overlaid in signals but has NO analytical row → ret/rvol must be null,
  // while its h_m STILL comes through from signals (the preserved/absent-overlay contract).
  await pg.db.insert(analyticalFeatures).values([
    { ticker: 'AAA', windowStart: W, ret: 0.023, rvol: 1.45, rvolConf: 'low', hM: 0.8 },
  ])
  await pg.db.insert(tickerNames).values([
    { symbol: 'AAA', name: 'ALPHA INC. COMMON STOCK' }, // → prettyName "Alpha Inc"
    // BBB intentionally absent → name ''
  ])
}

describe('readBoard — the SSR read contract', () => {
  it('returns no-data when there is no complete window', async () => {
    const board = await readBoard(pg.db)
    expect(board.state).toBe('no-data')
    expect(board.window).toBeNull()
    expect(board.rows).toEqual([])
    expect(board.movers).toEqual([])
  })

  it('orders by the canonical board total order and assigns sequential ranks', async () => {
    await seedOkCycle()
    const board = await readBoard(pg.db)
    expect(board.state).toBe('ok')
    expect(board.window?.start).toBe(W)
    expect(board.rows.map((r) => r.ticker)).toEqual(['AAA', 'BBB', 'CCC', 'DDD'])
    expect(board.rows.map((r) => r.rank)).toEqual([1, 2, 3, 4])
  })

  it('sources h_m/divergence/quadrant from signals and ret/rvol from analytical (null-tolerant)', async () => {
    await seedOkCycle()
    const board = await readBoard(pg.db)
    const by = Object.fromEntries(board.rows.map((r) => [r.ticker, r]))

    // AAA: fully overlaid
    expect(by.AAA!.hM).toBe(0.8)
    expect(by.AAA!.quadrant).toBe('CONFIRMED')
    expect(by.AAA!.ret).toBe(0.023)
    expect(by.AAA!.rvol).toBe(1.45)
    expect(by.AAA!.name).toBe('Alpha Inc') // prettyName applied

    // BBB: overlaid in SIGNALS (h_m present) but NO analytical row → ret/rvol null. The key contract:
    // H_m comes from signals, not analytical.
    expect(by.BBB!.hM).toBe(0.2)
    expect(by.BBB!.quadrant).toBe('HYPE')
    expect(by.BBB!.ret).toBeNull()
    expect(by.BBB!.rvol).toBeNull()
    expect(by.BBB!.name).toBe('') // no ticker_names row

    // CCC: signals row with null market cols
    expect(by.CCC!.hM).toBeNull()
    expect(by.CCC!.quadrant).toBeNull()

    // DDD: NO signals row at all → all signal-derived cols null via LEFT JOIN (still on the board)
    expect(by.DDD!.hM).toBeNull()
    expect(by.DDD!.divergence).toBeNull()
    expect(by.DDD!.quadrant).toBeNull()
    expect(by.DDD!.rankDelta).toBeNull()
  })

  it('never serves a non-complete (half-written) later window — returns the latest COMPLETE one', async () => {
    await seedOkCycle() // complete @ W
    const W2 = W + 3600
    // A later cycle that is NOT marked complete (status='partial'), with its own empirical rows.
    await pg.db.insert(cycleRuns).values({ windowStart: W2, generatedAt: W2 + 10, totalMentions: 5, quiet: true, capped: false, newestUtc: W2, status: 'partial' })
    await pg.db.insert(empiricalFeatures).values([{ ticker: 'ZZZ', windowStart: W2, mentions: 5, authors: 1, sov: 1, netDir: 0, ddCount: 0, baselineStatus: 'cold', hE: 0.5 }])

    const board = await readBoard(pg.db)
    expect(board.window?.start).toBe(W) // NOT W2
    expect(board.rows.some((r) => r.ticker === 'ZZZ')).toBe(false)
  })

  it('returns state=empty for a complete window with no board rows', async () => {
    await pg.db.insert(cycleRuns).values({ windowStart: W, generatedAt: W + 300, totalMentions: 0, quiet: true, capped: false, newestUtc: null, status: 'complete' })
    const board = await readBoard(pg.db)
    expect(board.state).toBe('empty')
    expect(board.window?.start).toBe(W)
    expect(board.rows).toEqual([])
  })

  it('surfaces quiet/capped flags from cycle_runs', async () => {
    await pg.db.insert(cycleRuns).values({ windowStart: W, generatedAt: W + 300, totalMentions: 12, quiet: true, capped: true, newestUtc: W + 60, status: 'complete' })
    await pg.db.insert(empiricalFeatures).values([{ ticker: 'AAA', windowStart: W, mentions: 12, authors: 2, sov: 1, netDir: 0, ddCount: 0, baselineStatus: 'cold', hE: 0.3 }])
    const board = await readBoard(pg.db)
    expect(board.window?.quiet).toBe(true)
    expect(board.window?.capped).toBe(true)
    expect(board.window?.newestUtc).toBe(W + 60)
  })

  it('returns only the latest market-movers capture, joined to names and ordered by kind,rank', async () => {
    await seedOkCycle()
    await pg.db.insert(tickerNames).values({ symbol: 'TSLA', name: 'TESLA, INC. COMMON STOCK' })
    await pg.db.insert(marketMovers).values([
      { ts: 100, kind: 'gainer', rank: 1, symbol: 'OLD', price: 1, percentChange: 1, volume: 1 }, // older capture — must be excluded
      { ts: 200, kind: 'gainer', rank: 2, symbol: 'NVDA', price: 120, percentChange: 3.1, volume: 1000 },
      { ts: 200, kind: 'gainer', rank: 1, symbol: 'TSLA', price: 250, percentChange: 5.2, volume: 2000 },
      { ts: 200, kind: 'active', rank: 1, symbol: 'AMD', price: 90, percentChange: -1.2, volume: 3000 },
    ])
    const board = await readBoard(pg.db)
    expect(board.movers.every((m) => m.ts === 200)).toBe(true)
    expect(board.movers.map((m) => `${m.kind}:${m.rank}`)).toEqual(['active:1', 'gainer:1', 'gainer:2'])
    const tsla = board.movers.find((m) => m.symbol === 'TSLA')
    expect(tsla?.name).toBe('Tesla, Inc') // prettyName applied to mover names
  })
})
