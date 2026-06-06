/**
 * Live-shadow DIFF (slice 9 — the cutover gate; v2-porting-spec §9, §2.6).
 *
 * Compares one cycle's TS dump (the worker, `shadow.ts`) against the oracle truth (`oracle/replay.py` fed
 * the SAME captured inputs). Because both sides consumed identical input, parity is **exact value + exact
 * order** (§2.6: the port is bit-exact to the oracle), NOT "within epsilon and roughly the same order".
 *
 * The ONE place a sub-ε tolerance is allowed (and §2.6 explicitly says it belongs HERE, never in the
 * production sort): a 1-ULP `h_e` flip — `0.4` vs `0.39999999999999997` — that legitimately reorders two
 * otherwise-equal rows. Such a flip is classified **NEAR** (tolerable), everything materially different is
 * **DRIFT** (a real port bug). Integer/string/null fields are bit-exact — any mismatch is DRIFT. The B3
 * mention stream (extraction/classification on real text) is pure, so it too must match exactly.
 *
 * Pure + dependency-free (no fs) so it unit-tests with synthetic dumps; the CLI (`shadow-cli.ts`) wraps it.
 */
import type { CycleDump, Readback, WireFeature, WireMention } from './shadow'

/** The oracle-side artifact replay.py emits — the same wire shape, but only the diffed boundaries.
 *  `wordset_match` is replay's check that its extractor wordlists matched the worker's (B3 parity premise);
 *  false ⇒ a stale `symbols.txt` etc., so any B3 mention diffs are a SETUP error, not a port bug. */
export interface OracleDump {
  schema_version: number
  window_start: number
  features: WireFeature[]
  mentions: WireMention[]
  wordset_match?: boolean | null
}

export type Verdict = 'MATCH' | 'NEAR' | 'DRIFT'

export interface FieldDiff {
  ticker: string
  field: string
  ts: unknown
  oracle: unknown
  verdict: 'NEAR' | 'DRIFT'
}

export interface OrderViolation {
  /** Board position (0-based) of the adjacent pair whose order the oracle reverses. */
  i: number
  tsPair: [string, string] // the TS board's order at (i, i+1)
  gap: number // ts[i].h_e − ts[i+1].h_e (≥0)
  /** Cross-engine h_e wobble for the pair (|tsₐ−orₐ| + |ts_b−or_b|). A flip is only NEAR if a real wobble
   *  explains it (wobble ≥ gap > 0); identical values reordered ⇒ a secondary-tie-break bug ⇒ DRIFT. */
  wobble: number
  verdict: 'NEAR' | 'DRIFT'
}

export interface MentionDiff {
  thing_id: string
  ticker: string
  field: string
  ts: unknown
  oracle: unknown
}

export interface CycleDiff {
  window_start: number
  verdict: Verdict
  /** Non-empty ⇒ DRIFT: the two boards disagree on which tickers are present at all. */
  membership: { missing_in_ts: string[]; missing_in_oracle: string[] }
  field_diffs: FieldDiff[]
  order_violations: OrderViolation[]
  mention_diffs: MentionDiff[] // B3
  /** The worker's post-publish read-back (write-path check, M4 review). `!ok` ⇒ DRIFT. Null if absent. */
  readback: Readback | null
  /** replay's wordlists didn't match the worker's ⇒ a SETUP error (not a port bug). B3 mention diffs are
   *  then attributed to this and excluded from the DRIFT rollup; the CLI flags it as a setup failure. */
  wordset_mismatch: boolean
  /** Fatal structural mismatch (schema/window) — diffing was impossible; always DRIFT. */
  fatal: string[]
  counts: { features: number; mentions: number; near: number; drift: number }
}

export interface DiffOptions {
  /** Absolute + relative tolerance for the sub-ε `h_e`/float tie. Defaults catch 1-ULP flips on [0,1]
   *  h_e while staying orders of magnitude below any real signal (real h_e gaps are ≥ ~1e-6). */
  absEps?: number
  relEps?: number
  /** Diff the B3 mention stream too (extraction/classification on real text). Default true. */
  checkMentions?: boolean
}

// Sub-ε tie tolerance — sized to the ACTUAL cross-language wobble (a ≤1-ULP `z` from Python `**0.5` vs TS
// `Math.sqrt`, §2.4): ~1e-15 for h_e/z magnitudes here. 1e-12 leaves ~1000× headroom yet flags any drift
// ≥ ~1e-11 as DRIFT. (Was 1e-9 — ~4.5M ULPs near 1.0, loose enough to hide a real small-math bug. M4 review.)
const ABS_EPS = 1e-12
const REL_EPS = 1e-12

/** True when a,b are equal or within the sub-ε tie tolerance (both must be finite numbers). */
function nearEqual(a: number, b: number, absEps: number, relEps: number): boolean {
  if (a === b) return true
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  return Math.abs(a - b) <= absEps + relEps * Math.max(Math.abs(a), Math.abs(b))
}

/** Numeric, null-aware field compare → null (equal), 'NEAR' (sub-ε), or 'DRIFT'. Null alignment is strict
 *  (velocity/accel/z null vs a number is load-bearing — §2.3 — so it is always DRIFT). */
function cmpNum(a: number | null, b: number | null, absEps: number, relEps: number): 'NEAR' | 'DRIFT' | null {
  if (a === null && b === null) return null
  if (a === null || b === null) return 'DRIFT' // null vs number — never tolerated
  if (a === b) return null
  return nearEqual(a, b, absEps, relEps) ? 'NEAR' : 'DRIFT'
}

/** Canonical compare of two flair_counts objects (keys + integer counts). Order-independent. */
function flairEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const k of ak) if (a[k] !== b[k]) return false
  return true
}

const NUMERIC_FEATURE_FIELDS = ['sov', 'velocity', 'accel', 'z', 'net_dir', 'h_e'] as const
const EXACT_FEATURE_FIELDS = ['mentions', 'authors', 'dd_count', 'baseline_status'] as const

/** Diff one cycle's TS board + mention stream against the oracle truth. Pure. */
export function diffCycle(ts: CycleDump, oracle: OracleDump, opts: DiffOptions = {}): CycleDiff {
  const absEps = opts.absEps ?? ABS_EPS
  const relEps = opts.relEps ?? REL_EPS
  const checkMentions = opts.checkMentions ?? true

  const fatal: string[] = []
  if (ts.schema_version !== oracle.schema_version) {
    fatal.push(`schema_version ${ts.schema_version} (ts) vs ${oracle.schema_version} (oracle)`)
  }
  if (ts.window_start !== oracle.window_start) {
    fatal.push(`window_start ${ts.window_start} (ts) vs ${oracle.window_start} (oracle)`)
  }

  const fieldDiffs: FieldDiff[] = []
  const orderViolations: OrderViolation[] = []
  const mentionDiffs: MentionDiff[] = []

  // --- B4: membership + per-field parity ----------------------------------------------------------
  const tsByTicker = new Map(ts.features.map((f) => [f.ticker, f]))
  const orByTicker = new Map(oracle.features.map((f) => [f.ticker, f]))
  const missingInTs = oracle.features.filter((f) => !tsByTicker.has(f.ticker)).map((f) => f.ticker).sort()
  const missingInOracle = ts.features.filter((f) => !orByTicker.has(f.ticker)).map((f) => f.ticker).sort()

  for (const tf of ts.features) {
    const of = orByTicker.get(tf.ticker)
    if (!of) continue // a membership diff, reported above — don't double-count as field diffs
    for (const field of NUMERIC_FEATURE_FIELDS) {
      const v = cmpNum(tf[field], of[field], absEps, relEps)
      if (v) fieldDiffs.push({ ticker: tf.ticker, field, ts: tf[field], oracle: of[field], verdict: v })
    }
    for (const field of EXACT_FEATURE_FIELDS) {
      if (tf[field] !== of[field]) {
        fieldDiffs.push({ ticker: tf.ticker, field, ts: tf[field], oracle: of[field], verdict: 'DRIFT' })
      }
    }
    if (!flairEqual(tf.flair_counts, of.flair_counts)) {
      fieldDiffs.push({
        ticker: tf.ticker, field: 'flair_counts', ts: tf.flair_counts, oracle: of.flair_counts, verdict: 'DRIFT',
      })
    }
  }

  // --- B4: order parity (the FULL comparator, not just h_e) ----------------------------------------
  // Both boards use the SAME total order (h_e desc → sov → authors → mentions → ticker). With the same
  // ticker set, any positional disagreement surfaces ≥1 adjacent inversion (a no-adjacent-inversion
  // permutation of [0..n) is the identity), so adjacent scanning is COMPLETE. The TS board is h_e-
  // descending, so gap = ts[i].h_e − ts[i+1].h_e ≥ 0. Classification (M3→M4 review fix):
  //   • gap > ε                                   → DRIFT (a material ordering bug).
  //   • gap ≤ ε AND a cross-engine h_e WOBBLE explains it (wobble ≥ gap > 0) → NEAR (a real 1-ULP tie flip).
  //   • gap ≤ ε but NO wobble (both engines have IDENTICAL h_e for the pair) → DRIFT — the order then rests
  //     purely on the secondary tie-break (sov→authors→mentions→ticker, all bit-identical across engines),
  //     so a reordering can ONLY be a secondary-comparator bug. (This is the gap the old h_e-gap-only check
  //     masked: a wrong tie-break among equal-h_e rows used to pass as NEAR.) We must NOT instead "correct"
  //     a genuine sub-ε flip via the secondary keys — that re-creates the §2.6 quantization bug; the wobble
  //     test distinguishes the two without consulting the secondary keys directly.
  if (missingInTs.length === 0 && missingInOracle.length === 0) {
    const orPos = new Map(oracle.features.map((f, i) => [f.ticker, i]))
    for (let i = 0; i + 1 < ts.features.length; i++) {
      const a = ts.features[i]!
      const b = ts.features[i + 1]!
      if (orPos.get(a.ticker)! > orPos.get(b.ticker)!) { // oracle ranks b above a → an inversion
        const gap = a.h_e - b.h_e
        const wobble = Math.abs(a.h_e - (orByTicker.get(a.ticker)?.h_e ?? a.h_e)) +
          Math.abs(b.h_e - (orByTicker.get(b.ticker)?.h_e ?? b.h_e))
        const tied = gap <= absEps + relEps * Math.max(Math.abs(a.h_e), Math.abs(b.h_e))
        orderViolations.push({
          i, tsPair: [a.ticker, b.ticker], gap, wobble,
          verdict: tied && wobble > 0 && wobble >= gap ? 'NEAR' : 'DRIFT',
        })
      }
    }
  }

  // --- B3: mention-stream parity (extraction/classification on real text — pure, so exact) ---------
  if (checkMentions) {
    const n = Math.max(ts.mentions.length, oracle.mentions.length)
    for (let i = 0; i < n; i++) {
      const t = ts.mentions[i]
      const o = oracle.mentions[i]
      if (!t || !o) {
        mentionDiffs.push({
          thing_id: (t ?? o)!.thing_id, ticker: (t ?? o)!.ticker, field: t ? 'missing_in_oracle' : 'missing_in_ts',
          ts: t ? `${t.ticker}@${t.thing_id}` : null, oracle: o ? `${o.ticker}@${o.thing_id}` : null,
        })
        continue
      }
      for (const field of ['ticker', 'thing_id', 'thing_type', 'author', 'flair', 'direction', 'created_utc'] as const) {
        if (t[field] !== o[field]) {
          mentionDiffs.push({ thing_id: t.thing_id, ticker: t.ticker, field, ts: t[field], oracle: o[field] })
        }
      }
    }
  }

  // --- roll up the verdict ------------------------------------------------------------------------
  // A wordset mismatch (stale symbols.txt etc.) is a SETUP error: it explains B3 mention diffs, so those
  // are NOT counted as port DRIFT (the CLI flags the mismatch separately and fails as a setup error). B4
  // is wordset-independent, so it still gates normally.
  const wordsetMismatch = oracle.wordset_match === false
  const readback = ts.readback ?? null
  const mentionDrift = wordsetMismatch ? 0 : mentionDiffs.length
  const drift =
    fatal.length > 0 ||
    missingInTs.length > 0 ||
    missingInOracle.length > 0 ||
    fieldDiffs.some((d) => d.verdict === 'DRIFT') ||
    orderViolations.some((d) => d.verdict === 'DRIFT') ||
    mentionDrift > 0 ||
    (readback != null && !readback.ok)
  const near =
    fieldDiffs.some((d) => d.verdict === 'NEAR') || orderViolations.some((d) => d.verdict === 'NEAR')
  const verdict: Verdict = drift ? 'DRIFT' : near ? 'NEAR' : 'MATCH'

  return {
    window_start: ts.window_start,
    verdict,
    membership: { missing_in_ts: missingInTs, missing_in_oracle: missingInOracle },
    field_diffs: fieldDiffs,
    order_violations: orderViolations,
    mention_diffs: mentionDiffs,
    readback,
    wordset_mismatch: wordsetMismatch,
    fatal,
    counts: {
      features: ts.features.length,
      mentions: ts.mentions.length,
      near: fieldDiffs.filter((d) => d.verdict === 'NEAR').length + orderViolations.filter((d) => d.verdict === 'NEAR').length,
      drift:
        fieldDiffs.filter((d) => d.verdict === 'DRIFT').length +
        orderViolations.filter((d) => d.verdict === 'DRIFT').length +
        mentionDrift + missingInTs.length + missingInOracle.length + fatal.length +
        (readback != null && !readback.ok ? readback.diffs.length || 1 : 0),
    },
  }
}

// --- multi-cycle roll-up ---------------------------------------------------------------------------

export interface ShadowReport {
  cycles: CycleDiff[]
  totals: { cycles: number; match: number; near: number; drift: number }
  verdict: Verdict
}

/** Aggregate per-cycle diffs into an overall report. Overall verdict = worst across cycles. */
export function summarize(diffs: CycleDiff[]): ShadowReport {
  const match = diffs.filter((d) => d.verdict === 'MATCH').length
  const near = diffs.filter((d) => d.verdict === 'NEAR').length
  const drift = diffs.filter((d) => d.verdict === 'DRIFT').length
  const verdict: Verdict = drift > 0 ? 'DRIFT' : near > 0 ? 'NEAR' : 'MATCH'
  return { cycles: diffs, totals: { cycles: diffs.length, match, near, drift }, verdict }
}
