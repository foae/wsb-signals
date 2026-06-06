import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { empiricalFeatures, type EmpiricalFeatureInsert } from '@wsb/shared'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { EmpiricalFeature } from '../src/aggregate'
import { type Db, upsertMentions } from '../src/db'
import { runAggregation } from '../src/pipeline'
import { startPg, type PgHarness } from './helpers/pg'

// Slice-6 KEYSTONE (porting-spec §1, §7): drive the LIVE Postgres reads → aggregate → persist chain and
// prove it reproduces the golden aggregate fixtures. We reconstruct each fixture's WORLD in Postgres from
// the same read-inputs it captured (mentions in window; empirical_features for prior/history; sov synthesized
// from the recorded ranks), run runAggregation, and assert the result matches the oracle's features (values
// + order) AND was persisted. This ties the new reads to the slice-2 oracle, end to end through Postgres.

type Snake = Record<string, any>

const loadAgg = (name: string): Snake =>
  JSON.parse(readFileSync(new URL(`../../../fixtures/aggregate/${name}.json`, import.meta.url), 'utf8'))

/** Rebuild the DB state the oracle's reads saw, so the live reads return the same inputs. */
async function seedWorld(db: Db, fx: Snake): Promise<void> {
  const i = fx.inputs
  const wsPrev = i.window_start - i.window_seconds

  const mentions = (i.mentions_in_window as Snake[]).map((m) => ({
    ticker: m[0], thingId: m[1], thingType: m[2], createdUtc: i.window_start + 1,
    author: m[3], flair: m[4], direction: m[5],
  }))
  if (mentions.length) await upsertMentions(db, mentions)

  // empirical_features: feature_history supplies (ticker, window, mentions); prior_features adds the W−1
  // velocity; prior_sov_ranks is reproduced by synthesizing strictly-descending sov values (the aggregate
  // only consumes the resulting RANKS, so any order-preserving sov works).
  const rows = new Map<string, EmpiricalFeatureInsert>()
  const key = (tk: string, w: number): string => `${tk}@${w}`
  for (const [tk, w, m] of i.feature_history as Array<[string, number, number]>) {
    rows.set(key(tk, w), { ticker: tk, windowStart: w, mentions: m, sov: 0, velocity: null })
  }
  for (const [tk, pf] of Object.entries(i.prior_features as Record<string, Snake>)) {
    const k = key(tk, wsPrev)
    const r = rows.get(k) ?? { ticker: tk, windowStart: wsPrev, mentions: pf.mentions ?? 0, sov: 0, velocity: null }
    r.mentions = pf.mentions ?? r.mentions
    r.velocity = pf.velocity ?? null
    rows.set(k, r)
  }
  for (const [tk, rank] of Object.entries(i.prior_sov_ranks as Record<string, number>)) {
    const k = key(tk, wsPrev)
    const r = rows.get(k) ?? { ticker: tk, windowStart: wsPrev, mentions: 0, sov: 0, velocity: null }
    r.sov = 1000 - rank
    rows.set(k, r)
  }
  if (rows.size) await db.insert(empiricalFeatures).values([...rows.values()])
}

function expectCloseOrNull(actual: number | null | undefined, expected: number | null, label: string): void {
  if (expected === null) expect(actual ?? null, label).toBeNull()
  else {
    expect(actual ?? null, label).not.toBeNull()
    expect(actual as number, label).toBeCloseTo(expected, 9)
  }
}

/**
 * Compare the live result to the oracle's features. Values are always checked (tolerant on floats).
 * Board ORDER is asserted strictly ONLY when the z weight is 0: when z contributes to H_e, the baseline
 * variance is a floating-point sum whose ROW ORDER differs between the oracle's DuckDB read (physical
 * order) and our Postgres read (ORDER BY window_start, ticker), so z — and thus H_e — can differ by a ULP
 * and flip a near-tie. That's a real RAW-sort property (same finding as the M1 quantization correction),
 * NOT a port bug; values still match within tolerance, so for z-weighted boards we assert the SET + values.
 */
function assertMatchesFixture(rows: EmpiricalFeature[], features: Snake[], strictOrder: boolean): void {
  expect(rows).toHaveLength(features.length)
  if (strictOrder) expect(rows.map((r) => r.ticker)).toEqual(features.map((f) => f.ticker))
  else expect([...rows.map((r) => r.ticker)].sort()).toEqual([...features.map((f) => f.ticker)].sort())

  const byTicker = new Map(rows.map((r) => [r.ticker, r]))
  features.forEach((exp) => {
    const a = byTicker.get(exp.ticker)!
    const at = exp.ticker
    expect(a, `${at} present`).toBeDefined()
    expect(a.mentions, `${at}.mentions`).toBe(exp.mentions)
    expect(a.authors, `${at}.authors`).toBe(exp.authors)
    expect(a.ddCount, `${at}.ddCount`).toBe(exp.dd_count)
    expect(a.baselineStatus, `${at}.baselineStatus`).toBe(exp.baseline_status)
    expect(a.flairCounts, `${at}.flairCounts`).toEqual(JSON.parse(exp.flair_counts))
    expectCloseOrNull(a.sov, exp.sov, `${at}.sov`)
    expectCloseOrNull(a.netDir, exp.net_dir, `${at}.netDir`)
    expectCloseOrNull(a.hE, exp.h_e, `${at}.hE`)
    expectCloseOrNull(a.velocity, exp.velocity, `${at}.velocity`)
    expectCloseOrNull(a.accel, exp.accel, `${at}.accel`)
    expectCloseOrNull(a.z, exp.z, `${at}.z`)
  })
}

// The named fixtures PLUS all 30 seeded random ones (tied SoV, varied hour-of-week buckets, cold/warming/
// ready baselines, half with a non-zero z weight) — exercising readSovRanksAt's tie-break + the window
// filter end-to-end through Postgres, not just the pure aggregator.
const RANDOM_DIR = fileURLToPath(new URL('../../../fixtures/aggregate/random/', import.meta.url))
const RANDOM = readdirSync(RANDOM_DIR).filter((f) => f.endsWith('.json')).sort().map((f) => `random/${f.replace('.json', '')}`)
const ALL = ['cold_start', 'basic_with_prior', 'baseline_ready', ...RANDOM]

let pg: PgHarness
beforeAll(async () => { pg = await startPg() })
afterAll(async () => { await pg?.stop() })
beforeEach(async () => { await pg.reset() })

describe('runAggregation end-to-end vs the oracle fixtures', () => {
  it.each(ALL)('%s reproduces the golden features', async (name) => {
    const fx = loadAgg(name)
    await seedWorld(pg.db, fx)

    const rows = await runAggregation(pg.db, fx.inputs.window_start, {
      windowSeconds: fx.inputs.window_seconds,
      weights: fx.inputs.weights,
      minSamplesReady: fx.inputs.min_samples_ready,
      minAuthorsFull: fx.inputs.min_authors_full,
    }, { persist: true })

    assertMatchesFixture(rows, fx.features, fx.inputs.weights.z === 0)

    // and the features were actually persisted at this window
    const persisted = await pg.db.select().from(empiricalFeatures)
      .where(eq(empiricalFeatures.windowStart, fx.inputs.window_start))
    expect(persisted).toHaveLength(fx.features.length)
  })
})
