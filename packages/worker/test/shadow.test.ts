import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { aggregateWindow, compareBoard, type AggregateInputs, type BoardRow } from '../src/aggregate'
import {
  buildCycleDump, canonicalJson, fnv1a, type CycleDump, type Readback, type WireFeature, type WireMention,
} from '../src/shadow'
import { diffCycle, summarize, type OracleDump } from '../src/shadow-diff'

// Slice 9 (live shadow): the parity GATE. These prove the diff classifies correctly (MATCH/NEAR/DRIFT) and
// that the capture+diff loop agrees with the FROZEN oracle on the golden fixtures — end-to-end, Docker-free.
// (The oracle REPLAY itself, oracle/replay.py, is verified separately to reproduce these same fixtures.)

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const loadFixture = (name: string): any =>
  JSON.parse(readFileSync(join(ROOT, 'fixtures', 'aggregate', `${name}.json`), 'utf8'))

/** Map a golden fixture's snake_case `inputs` to the TS aggregator's camelCase AggregateInputs. */
function toInputs(fx: any): AggregateInputs {
  const i = fx.inputs
  return {
    windowStart: i.window_start, windowSeconds: i.window_seconds, weights: i.weights,
    minSamplesReady: i.min_samples_ready, minAuthorsFull: i.min_authors_full,
    mentionsInWindow: i.mentions_in_window, priorFeatures: i.prior_features,
    priorSovRanks: i.prior_sov_ranks, featureHistory: i.feature_history,
  }
}

/** The fixture's `features` ARE the oracle truth; normalize flair_counts (a JSON string there) → object. */
function oracleFromFixture(fx: any): OracleDump {
  return {
    schema_version: 1,
    window_start: fx.inputs.window_start,
    features: fx.features.map((f: any): WireFeature => ({
      ...f, flair_counts: f.flair_counts ? JSON.parse(f.flair_counts) : {},
    })),
    mentions: [],
  }
}

describe('shadow capture + diff — golden-fixture parity (end-to-end, Docker-free)', () => {
  for (const name of ['basic_with_prior', 'cold_start', 'baseline_ready']) {
    it(`MATCHes the oracle on ${name}`, () => {
      const inputs = toInputs(loadFixture(name))
      const rows = aggregateWindow(inputs)
      const dump = buildCycleDump({
        windowStart: inputs.windowStart, windowSeconds: inputs.windowSeconds, generatedAt: inputs.windowStart + 250,
        capped: false, newestUtc: null, poll: { posts: [], comments: [] }, mentions: [], inputs, features: rows,
      })
      const diff = diffCycle(dump, oracleFromFixture(loadFixture(name)))
      expect(diff.verdict).toBe('MATCH')
      expect(diff.counts.drift).toBe(0)
      expect(diff.field_diffs).toHaveLength(0)
      expect(diff.order_violations).toHaveLength(0)
    })
  }

  // No DRIFT across the 30 randomized adversarial fixtures. A few land NEAR — NOT a bug: the oracle's z
  // uses Python `var ** 0.5` (libm pow, occasionally 1 ULP off correctly-rounded) while the TS port uses
  // (correctly-rounded) `Math.sqrt`, so `z` can differ by ≤1 ULP on ~0.08% of baseline-ready tickers. The
  // parity test already tolerates this at 1e-9; the shadow-diff surfaces it explicitly as NEAR. This is the
  // canonical case the sub-ε tolerance exists for (porting-spec §2.6, §9) — the gate must NOT flag it DRIFT.
  it('has NO DRIFT across the 30 randomized adversarial fixtures (sub-ε z wobble lands NEAR)', () => {
    const diffs = []
    for (let i = 0; i < 30; i++) {
      const fx = loadFixture(`random/${String(i).padStart(3, '0')}`)
      const inputs = toInputs(fx)
      const rows = aggregateWindow(inputs)
      const dump = buildCycleDump({
        windowStart: inputs.windowStart, windowSeconds: inputs.windowSeconds, generatedAt: inputs.windowStart,
        capped: false, newestUtc: null, poll: { posts: [], comments: [] }, mentions: [], inputs, features: rows,
      })
      diffs.push(diffCycle(dump, oracleFromFixture(fx)))
    }
    expect(diffs.every((d) => d.verdict !== 'DRIFT')).toBe(true)
    // every NEAR is explained ONLY by a sub-ε z field diff — never membership, order, or any other field.
    for (const d of diffs.filter((x) => x.verdict === 'NEAR')) {
      expect(d.membership.missing_in_ts.concat(d.membership.missing_in_oracle)).toHaveLength(0)
      expect(d.order_violations).toHaveLength(0)
      expect(d.field_diffs.every((f) => f.field === 'z' && f.verdict === 'NEAR')).toBe(true)
    }
  })
})

// --- synthetic classification cases ----------------------------------------------------------------

const feat = (over: Partial<WireFeature> & Pick<WireFeature, 'ticker' | 'h_e'>): WireFeature => ({
  window_start: 1_704_067_200, mentions: 3, authors: 2, sov: 0.5, velocity: 1, accel: null, z: null,
  net_dir: 0, dd_count: 0, flair_counts: {}, baseline_status: 'cold', ...over,
})

const tsDump = (features: WireFeature[], mentions: WireMention[] = [], readback: Readback | null = null): CycleDump => ({
  schema_version: 1, window_start: 1_704_067_200, window_seconds: 3600, generated_at: 1_704_067_300,
  capped: false, newest_utc: null, wordsets: null, poll: { posts: [], comments: [] }, mentions,
  inputs: {} as any, features, readback,
})
const orDump = (features: WireFeature[], mentions: WireMention[] = [], wordsetMatch?: boolean): OracleDump => ({
  schema_version: 1, window_start: 1_704_067_200, features, mentions, wordset_match: wordsetMatch,
})

describe('diffCycle — value classification', () => {
  it('identical boards → MATCH', () => {
    const f = [feat({ ticker: 'NVDA', h_e: 0.9 }), feat({ ticker: 'AMD', h_e: 0.4 })]
    expect(diffCycle(tsDump(f), orDump(f.map((x) => ({ ...x })))).verdict).toBe('MATCH')
  })

  it('a material value drift → DRIFT', () => {
    const ts = [feat({ ticker: 'NVDA', h_e: 0.9, sov: 0.5 })]
    const or = [feat({ ticker: 'NVDA', h_e: 0.9, sov: 0.6 })]
    const d = diffCycle(tsDump(ts), orDump(or))
    expect(d.verdict).toBe('DRIFT')
    expect(d.field_diffs.find((x) => x.field === 'sov')!.verdict).toBe('DRIFT')
  })

  it('a sub-ULP h_e difference → NEAR (the one allowed tolerance), not DRIFT', () => {
    const ts = [feat({ ticker: 'NVDA', h_e: 0.4 })]
    const or = [feat({ ticker: 'NVDA', h_e: 0.39999999999999997 })] // 1 ULP below 0.4
    const d = diffCycle(tsDump(ts), orDump(or))
    expect(d.verdict).toBe('NEAR')
    expect(d.field_diffs.find((x) => x.field === 'h_e')!.verdict).toBe('NEAR')
  })

  it('null vs number (velocity/accel/z) is load-bearing → DRIFT, never tolerated', () => {
    const ts = [feat({ ticker: 'NVDA', h_e: 0.9, velocity: null })]
    const or = [feat({ ticker: 'NVDA', h_e: 0.9, velocity: 2 })]
    expect(diffCycle(tsDump(ts), orDump(or)).verdict).toBe('DRIFT')
  })

  it('flair_counts compared as counts (object), mismatch → DRIFT', () => {
    const ts = [feat({ ticker: 'NVDA', h_e: 0.9, flair_counts: { DD: 1 } })]
    const or = [feat({ ticker: 'NVDA', h_e: 0.9, flair_counts: { DD: 2 } })]
    expect(diffCycle(tsDump(ts), orDump(or)).field_diffs.some((x) => x.field === 'flair_counts')).toBe(true)
  })

  it('an exact integer field (mentions) mismatch → DRIFT', () => {
    const ts = [feat({ ticker: 'NVDA', h_e: 0.9, mentions: 3 })]
    const or = [feat({ ticker: 'NVDA', h_e: 0.9, mentions: 4 })]
    expect(diffCycle(tsDump(ts), orDump(or)).verdict).toBe('DRIFT')
  })
})

describe('diffCycle — membership + order', () => {
  it('a ticker present in only one board → DRIFT (membership)', () => {
    const ts = [feat({ ticker: 'NVDA', h_e: 0.9 }), feat({ ticker: 'AMD', h_e: 0.4 })]
    const or = [feat({ ticker: 'NVDA', h_e: 0.9 })]
    const d = diffCycle(tsDump(ts), orDump(or))
    expect(d.verdict).toBe('DRIFT')
    expect(d.membership.missing_in_oracle).toEqual(['AMD'])
  })

  it('same values but a real order flip → DRIFT (a sort/comparator bug)', () => {
    const ts = [feat({ ticker: 'NVDA', h_e: 0.9 }), feat({ ticker: 'AMD', h_e: 0.5 })]
    const or = [feat({ ticker: 'AMD', h_e: 0.5 }), feat({ ticker: 'NVDA', h_e: 0.9 })]
    const d = diffCycle(tsDump(ts), orDump(or))
    expect(d.verdict).toBe('DRIFT')
    expect(d.order_violations.some((v) => v.verdict === 'DRIFT')).toBe(true)
  })

  it('a sub-ε h_e tie flip in order → NEAR (tolerable), not DRIFT', () => {
    // The two rows are within ε; the boards order them oppositely (a 1-ULP flip). Values also within ε —
    // so a cross-engine h_e WOBBLE explains the flip → NEAR.
    const ts = [feat({ ticker: 'NVDA', h_e: 0.4000000000000001 }), feat({ ticker: 'AMD', h_e: 0.4 })]
    const or = [feat({ ticker: 'AMD', h_e: 0.4000000000000001 }), feat({ ticker: 'NVDA', h_e: 0.4 })]
    const d = diffCycle(tsDump(ts), orDump(or))
    expect(d.verdict).toBe('NEAR')
    expect(d.order_violations.every((v) => v.verdict === 'NEAR')).toBe(true)
  })

  it('M4 fix: a tie-break bug among IDENTICAL-h_e rows → DRIFT (no wobble can explain the flip)', () => {
    // h_e is bit-identical on both engines (gap=0, wobble=0); the reorder can ONLY be a wrong secondary
    // tie-break (sov→authors→mentions→ticker). The old h_e-gap-only classifier wrongly passed this as NEAR.
    const ts = [feat({ ticker: 'AAA', h_e: 0.5 }), feat({ ticker: 'BBB', h_e: 0.5 })]
    const or = [feat({ ticker: 'BBB', h_e: 0.5 }), feat({ ticker: 'AAA', h_e: 0.5 })]
    const d = diffCycle(tsDump(ts), orDump(or))
    expect(d.verdict).toBe('DRIFT')
    expect(d.order_violations.some((v) => v.verdict === 'DRIFT' && v.wobble === 0)).toBe(true)
  })
})

describe('diffCycle — M4: tightened ε (no longer masks small drift)', () => {
  it('a ~1e-10 h_e drift is DRIFT (was NEAR under the old 1e-9 relEps)', () => {
    const ts = [feat({ ticker: 'NVDA', h_e: 0.5 })]
    const or = [feat({ ticker: 'NVDA', h_e: 0.5 + 1e-10 })]
    expect(diffCycle(tsDump(ts), orDump(or)).verdict).toBe('DRIFT')
  })
  it('a true ~1-ULP wobble (1e-16) is still NEAR', () => {
    const ts = [feat({ ticker: 'NVDA', h_e: 0.5, z: -0.6186158035222600 })]
    const or = [feat({ ticker: 'NVDA', h_e: 0.5, z: -0.6186158035222599 })]
    const d = diffCycle(tsDump(ts), orDump(or))
    expect(d.verdict).toBe('NEAR')
  })
})

describe('diffCycle — M4: read-back (write-path) + wordset mismatch', () => {
  const okFeat = [feat({ ticker: 'NVDA', h_e: 0.9 })]

  it('a failed post-publish read-back → DRIFT (the persisted board diverges)', () => {
    const readback: Readback = {
      ok: false, cycle_run: true,
      diffs: [{ table: 'empirical', ticker: 'NVDA', field: 'h_e', in_memory: 0.9, persisted: null }],
    }
    const d = diffCycle(tsDump(okFeat, [], readback), orDump(okFeat.map((x) => ({ ...x }))))
    expect(d.verdict).toBe('DRIFT')
    expect(d.readback?.ok).toBe(false)
  })

  it('a passing read-back does not force DRIFT', () => {
    const readback: Readback = { ok: true, cycle_run: true, diffs: [] }
    expect(diffCycle(tsDump(okFeat, [], readback), orDump(okFeat.map((x) => ({ ...x })))).verdict).toBe('MATCH')
  })

  it('a wordset mismatch attributes B3 mention diffs to SETUP (not DRIFT) and flags it', () => {
    const tsM = [{ ticker: 'NVDA', thing_id: 'c1', thing_type: 'comment', created_utc: 1, author: 'a', flair: null, direction: 'bull' }]
    const orM = [{ ...tsM[0]!, direction: 'bear' }]
    const d = diffCycle(tsDump([], tsM), orDump([], orM, /* wordsetMatch */ false))
    expect(d.wordset_mismatch).toBe(true)
    expect(d.verdict).not.toBe('DRIFT') // the mention diff is a setup artifact, excluded from the rollup
    expect(d.mention_diffs.length).toBeGreaterThan(0) // still reported
  })

  it('with matching wordsets, the same B3 divergence IS a DRIFT (a real extraction bug)', () => {
    const tsM = [{ ticker: 'NVDA', thing_id: 'c1', thing_type: 'comment', created_utc: 1, author: 'a', flair: null, direction: 'bull' }]
    const orM = [{ ...tsM[0]!, direction: 'bear' }]
    expect(diffCycle(tsDump([], tsM), orDump([], orM, /* wordsetMatch */ true)).verdict).toBe('DRIFT')
  })

  it('a schema_version / window_start mismatch is FATAL → DRIFT', () => {
    const f = [feat({ ticker: 'NVDA', h_e: 0.9 })]
    const d = diffCycle({ ...tsDump(f), schema_version: 2 }, orDump(f))
    expect(d.verdict).toBe('DRIFT')
    expect(d.fatal.length).toBeGreaterThan(0)
  })
})

describe('diffCycle — B3 mention stream', () => {
  const m = (over: Partial<WireMention> & Pick<WireMention, 'ticker' | 'thing_id'>): WireMention => ({
    thing_type: 'comment', created_utc: 1_704_067_250, author: 'alice', flair: null, direction: 'bull', ...over,
  })

  it('identical mention streams → MATCH', () => {
    const ms = [m({ ticker: 'NVDA', thing_id: 'c1' }), m({ ticker: 'AMD', thing_id: 'c2' })]
    expect(diffCycle(tsDump([], ms), orDump([], ms.map((x) => ({ ...x })))).verdict).toBe('MATCH')
  })

  it('a direction divergence on the same text → DRIFT', () => {
    const ts = [m({ ticker: 'NVDA', thing_id: 'c1', direction: 'bull' })]
    const or = [m({ ticker: 'NVDA', thing_id: 'c1', direction: 'bear' })]
    const d = diffCycle(tsDump([], ts), orDump([], or))
    expect(d.verdict).toBe('DRIFT')
    expect(d.mention_diffs.some((x) => x.field === 'direction')).toBe(true)
  })

  it('an extra extracted ticker (length mismatch) → DRIFT', () => {
    const ts = [m({ ticker: 'AMD', thing_id: 'c1' }), m({ ticker: 'NVDA', thing_id: 'c1' })]
    const or = [m({ ticker: 'NVDA', thing_id: 'c1' })]
    expect(diffCycle(tsDump([], ts), orDump([], or)).verdict).toBe('DRIFT')
  })

  it('can be turned off (checkMentions: false) — B4-only diff', () => {
    const ts = [m({ ticker: 'NVDA', thing_id: 'c1', direction: 'bull' })]
    const or = [m({ ticker: 'NVDA', thing_id: 'c1', direction: 'bear' })]
    expect(diffCycle(tsDump([], ts), orDump([], or), { checkMentions: false }).verdict).toBe('MATCH')
  })
})

describe('compareBoard is a TOTAL ORDER (guards the adjacent-pair order check)', () => {
  // The order classifier's adjacent-pair scan is COMPLETE only if compareBoard is a total order — otherwise
  // a non-transitive comparator could let a 3-cycle permutation slip through with no adjacent inversion
  // (M4 review, qwen). Property-test antisymmetry + transitivity over random boards.
  const row = fc.record({
    hE: fc.double({ min: 0, max: 1, noNaN: true }),
    sov: fc.double({ min: 0, max: 1, noNaN: true }),
    authors: fc.integer({ min: 0, max: 50 }),
    mentions: fc.integer({ min: 0, max: 500 }),
    ticker: fc.string({ minLength: 1, maxLength: 5 }),
  }) as fc.Arbitrary<BoardRow>
  const sgn = (n: number): number => (n < 0 ? -1 : n > 0 ? 1 : 0)

  it('is reflexive + antisymmetric', () => {
    fc.assert(fc.property(row, row, (a, b) => {
      expect(compareBoard(a, a)).toBe(0)
      expect(sgn(compareBoard(a, b))).toBe(-sgn(compareBoard(b, a)))
    }))
  })
  it('is transitive', () => {
    fc.assert(fc.property(row, row, row, (a, b, c) => {
      if (compareBoard(a, b) <= 0 && compareBoard(b, c) <= 0) expect(compareBoard(a, c)).toBeLessThanOrEqual(0)
    }))
  })
})

describe('fnv1a — the cross-language wordset-fingerprint contract', () => {
  it('matches the values oracle/replay.py reproduces (locks the contract)', () => {
    expect(fnv1a('')).toBe(2166136261) // the FNV offset basis 0x811c9dc5
    expect(fnv1a('NVDA')).toBe(2591302102)
    expect(fnv1a('NVDA\nAMD\nGME')).toBe(1235026171)
  })
})

describe('summarize + canonicalJson', () => {
  it('rolls the worst per-cycle verdict up to the report', () => {
    const f = [feat({ ticker: 'NVDA', h_e: 0.9 })]
    const match = diffCycle(tsDump(f), orDump(f.map((x) => ({ ...x }))))
    const drift = diffCycle(tsDump(f), orDump([feat({ ticker: 'NVDA', h_e: 0.9, mentions: 9 })]))
    expect(summarize([match]).verdict).toBe('MATCH')
    expect(summarize([match, drift]).verdict).toBe('DRIFT')
    expect(summarize([match, drift]).totals).toMatchObject({ cycles: 2, match: 1, drift: 1 })
  })

  it('canonicalJson sorts keys recursively + ends with a newline (stable on disk)', () => {
    const s = canonicalJson({ b: 1, a: { d: 2, c: 3 } })
    expect(s.endsWith('\n')).toBe(true)
    expect(s.indexOf('"a"')).toBeLessThan(s.indexOf('"b"'))
    expect(s.indexOf('"c"')).toBeLessThan(s.indexOf('"d"'))
  })
})
