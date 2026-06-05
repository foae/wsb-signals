import { empiricalFeatures } from '@wsb/shared'
import type { EmpiricalFeatureInsert } from '@wsb/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  acquireAdvisoryLock, createDb, readFeatureHistory, readFeaturesAt, readMentionsInWindow, readSovRanksAt,
  upsertMentions,
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

  it('readFeatureHistory returns every row with window_start < before', async () => {
    await pg.db.insert(empiricalFeatures).values([
      feat({ ticker: 'NVDA', windowStart: 1000, mentions: 3 }),
      feat({ ticker: 'NVDA', windowStart: 2000, mentions: 5 }),
      feat({ ticker: 'AMD', windowStart: 2000, mentions: 4 }),
      feat({ ticker: 'NVDA', windowStart: 3000, mentions: 7 }), // >= before → excluded
    ])
    const hist = await readFeatureHistory(pg.db, 2500)
    expect(hist).toEqual([['NVDA', 1000, 3], ['AMD', 2000, 4], ['NVDA', 2000, 5]]) // ordered (window_start, ticker)
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
})
