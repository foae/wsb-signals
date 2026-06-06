import { empiricalFeatures } from '@wsb/shared'
import type { EmpiricalFeatureInsert } from '@wsb/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { hourOfWeek } from '../src/aggregate'
import {
  acquireAdvisoryLock, advisoryLockAlive, createDb, readFeatureHistory, readFeaturesAt,
  readMentionsInWindow, readSovRanksAt, upsertMentions,
} from '../src/db'
import { startPg, type PgHarness } from './helpers/pg'

// Slice-6 reads (porting-spec §7): the four DB reads aggregate consumes, on real Postgres — exercising
// the window filter, the `thing_id` / `sov DESC, ticker ASC` ORDER BY contracts, and the advisory lock.

let pg: PgHarness
beforeAll(async () => { pg = await startPg() })
afterAll(async () => { await pg?.stop() })
beforeEach(async () => { await pg.reset() })

const feat = (over: Partial<EmpiricalFeatureInsert> & { ticker: string; windowStart: number }): EmpiricalFeatureInsert =>
  ({ mentions: 0, sov: 0, velocity: null, ...over })

describe('aggregator reads on Postgres', () => {
  it('readMentionsInWindow filters [start,end) and orders by thing_id', async () => {
    await upsertMentions(pg.db, [
      { ticker: 'NVDA', thingId: 't3', thingType: 'comment', createdUtc: 1500, author: 'a', flair: null, direction: 'bull' },
      { ticker: 'AMD', thingId: 't2', thingType: 'post', createdUtc: 1900, author: 'b', flair: 'DD', direction: 'bear' },
      { ticker: 'NVDA', thingId: 't1', thingType: 'post', createdUtc: 1000, author: 'c', flair: null, direction: 'neutral' },
      { ticker: 'GME', thingId: 't9', thingType: 'comment', createdUtc: 999, author: 'd', flair: null, direction: 'bull' }, // before window
      { ticker: 'GME', thingId: 't8', thingType: 'comment', createdUtc: 2000, author: 'e', flair: null, direction: 'bull' }, // == end (excluded)
    ])
    const rows = await readMentionsInWindow(pg.db, 1000, 2000)
    expect(rows.map((r) => r[1])).toEqual(['t1', 't2', 't3']) // ordered by thing_id; t8/t9 out of window
    expect(rows[0]).toEqual(['NVDA', 't1', 'post', 'c', null, 'neutral'])
    expect(rows[1]).toEqual(['AMD', 't2', 'post', 'b', 'DD', 'bear'])
  })

  it('readFeaturesAt returns mentions + velocity by ticker at one window', async () => {
    await pg.db.insert(empiricalFeatures).values([
      feat({ ticker: 'NVDA', windowStart: 5000, mentions: 2, velocity: 1 }),
      feat({ ticker: 'TSLA', windowStart: 5000, mentions: 3, velocity: null }),
      feat({ ticker: 'AMD', windowStart: 4000, mentions: 9, velocity: 2 }), // other window — must not appear
    ])
    const prior = await readFeaturesAt(pg.db, 5000)
    expect(prior).toEqual({ NVDA: { mentions: 2, velocity: 1 }, TSLA: { mentions: 3, velocity: null } })
  })

  it('readFeatureHistory is scoped to the hour-of-week bucket AND bounded to [from, before)', async () => {
    // v2 bounded+scoped baseline read (porting-spec §2.7). W0 = 2024-01-01 00:00 UTC (a Monday) → bucket 0.
    const W0 = 1_704_067_200
    const WEEK = 604_800
    // Pin the SQL hour_of_week expression against the scorer's hourOfWeek: the bucket-0 rows must be 0, and
    // the off-by-one-hour row (Sunday 23:00 UTC) must be 167 — so the wrong-bucket exclusion below proves
    // the SQL `dow`/`hour` math matches aggregate.hourOfWeek, not just that some filter ran.
    expect(hourOfWeek(W0)).toBe(0)
    expect(hourOfWeek(W0 - 3600)).toBe(167)

    await pg.db.insert(empiricalFeatures).values([
      feat({ ticker: 'NVDA', windowStart: W0 - 40 * WEEK, mentions: 99 }), // bucket 0 but older than `from` → excluded
      feat({ ticker: 'NVDA', windowStart: W0 - WEEK, mentions: 5 }), //       bucket 0, in range → included
      feat({ ticker: 'NVDA', windowStart: W0, mentions: 3 }), //              bucket 0, in range → included
      feat({ ticker: 'AMD', windowStart: W0, mentions: 4 }), //               bucket 0, in range → included (ticker tie-break)
      feat({ ticker: 'TSLA', windowStart: W0 - 3600, mentions: 7 }), //       bucket 167 (in range) → excluded by hour-of-week
      feat({ ticker: 'NVDA', windowStart: W0 + WEEK, mentions: 50 }), //      bucket 0 but >= before → excluded
    ])

    const before = W0 + 1
    const from = before - 26 * WEEK // 26-week trailing bound
    const hist = await readFeatureHistory(pg.db, before, from, 0)
    // ordered (window_start ASC, ticker C-collation); only same-bucket rows within the bound survive.
    expect(hist).toEqual([['NVDA', W0 - WEEK, 5], ['AMD', W0, 4], ['NVDA', W0, 3]])
  })

  it('the SQL hour_of_week expression matches aggregate.hourOfWeek across diverse buckets', async () => {
    // W0 (Monday 00:00 UTC) + k hours lands in hour_of_week bucket k (for k in 0..167). Insert one row per
    // chosen bucket, then for each query with how=k and assert exactly that row returns — pinning the SQL
    // `(((dow+6)%7)*24 + hour)` to the JS `((getUTCDay()+6)%7)*24 + getUTCHours()` across the week, not just
    // the Mon/Sun boundary. A mismatch in the SQL dow/hour math would return the wrong row (or none).
    const W0 = 1_704_067_200 // Monday 00:00 UTC
    const HOUR = 3600
    const buckets = [0, 1, 13, 23, 24, 62, 143, 156, 167] // Mon, …, Wed 14:00, …, Sat 23:00, Sun 12:00, Sun 23:00
    for (const k of buckets) expect(hourOfWeek(W0 + k * HOUR), `JS hourOfWeek bucket ${k}`).toBe(k)

    await pg.db.insert(empiricalFeatures).values(
      buckets.map((k) => feat({ ticker: `T${k}`, windowStart: W0 + k * HOUR, mentions: k + 1 })),
    )
    const before = W0 + 168 * HOUR // end of the week — everything is in range
    for (const k of buckets) {
      const hist = await readFeatureHistory(pg.db, before, 0, k)
      expect(hist, `SQL bucket ${k}`).toEqual([[`T${k}`, W0 + k * HOUR, k + 1]])
    }
  })

  it('readSovRanksAt ranks by sov DESC, ticker ASC (the rank_delta tie-break)', async () => {
    await pg.db.insert(empiricalFeatures).values([
      feat({ ticker: 'A', windowStart: 6000, sov: 0.5 }),
      feat({ ticker: 'B', windowStart: 6000, sov: 0.9 }),
      feat({ ticker: 'C', windowStart: 6000, sov: 0.5 }), // tie with A → ticker ASC breaks it (A before C)
    ])
    expect(await readSovRanksAt(pg.db, 6000)).toEqual({ B: 1, A: 2, C: 3 })
  })

  it('acquireAdvisoryLock is a mutual-exclusion guard across connections', async () => {
    const a = createDb(pg.container.getConnectionUri())
    const b = createDb(pg.container.getConnectionUri())
    try {
      const lockA = await acquireAdvisoryLock(a.pool, 990011)
      expect(lockA).not.toBeNull()
      expect(await acquireAdvisoryLock(b.pool, 990011)).toBeNull() // A holds it
      lockA!.release()
      await a.close() // ending A's pool closes the session → the lock drops
      const lockB = await acquireAdvisoryLock(b.pool, 990011)
      expect(lockB).not.toBeNull()
      lockB!.release()
    } finally {
      await b.close()
    }
  })

  it('advisoryLockAlive reports liveness and detects a dead connection (lock-loss guard)', async () => {
    const a = createDb(pg.container.getConnectionUri())
    const lock = await acquireAdvisoryLock(a.pool, 990022)
    expect(lock).not.toBeNull()
    expect(await advisoryLockAlive(lock!)).toBe(true) // held + connection healthy
    lock!.release()
    await a.close() // pool ended → the underlying connection is gone
    expect(await advisoryLockAlive(lock!)).toBe(false) // a query now throws → the lock is considered lost
  })
})
