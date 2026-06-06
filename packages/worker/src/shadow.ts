/**
 * Live-shadow cycle dump (slice 9 — the deterministic replay-vs-oracle parity gate; v2-porting-spec §9).
 *
 * The live shadow proves the TS worker reproduces the FROZEN Python oracle on REAL data, deterministically.
 * The trick: we do NOT run two independent live pollers (their separate polls fetch different data, so
 * their boards could never match exactly — a noisy, un-gateable comparison). Instead the ONE live TS worker
 * captures, per cycle, the EXACT inputs its scorer consumed plus the board it produced; `oracle/replay.py`
 * feeds those identical inputs through the frozen `aggregate_window`; and `shadow-diff` asserts value+order
 * parity at the object boundary (NOT DB rows — §1). Same input → any divergence is a real port bug, not
 * input noise. This is strictly stronger than the committed golden fixtures: it runs the parity contract
 * continuously against whatever real-world ticker/flair/author/unicode shapes the live firehose produces.
 *
 * This module is the CAPTURE side (imported by the worker hot path, so it stays lean — no diff/CLI here).
 * The wire form is canonical **snake_case**, matching the Python `model_dump()` field names so replay.py
 * consumes it directly and the diff compares like-for-like. Floats are written with the JS shortest-
 * round-trip repr; the diff parses numbers (never string repr), so a bit-exact port round-trips identically.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { MentionInsert, RawCommentInsert, RawPostInsert } from '@wsb/shared'

import type { AggregateInputs, EmpiricalFeature, HeatWeights } from './aggregate'
import type { PollResult } from './ingest'

/** Bump when the wire shape changes; replay.py/shadow-diff assert on it so a stale dump can't be diffed. */
export const SHADOW_SCHEMA_VERSION = 1

// --- canonical wire types (snake_case = Python model_dump parity) ----------------------------------

export interface WirePost {
  id: string
  created_utc: number | null
  author: string | null
  title: string | null
  selftext: string | null
  link_flair_text: string | null
  score: number | null
  num_comments: number | null
  retrieved_on: number | null
  source: string | null
}

export interface WireComment {
  id: string
  created_utc: number | null
  author: string | null
  link_id: string | null
  parent_id: string | null
  body: string | null
  score: number | null
  retrieved_on: number | null
  source: string | null
}

export interface WireMention {
  ticker: string
  thing_id: string
  thing_type: string | null
  created_utc: number | null
  author: string | null
  flair: string | null
  direction: string | null
}

/** A mention row exactly as `aggregate_window` iterates it: [ticker, thing_id, thing_type, author, flair, direction]. */
export type WireMentionRow = [string, string, string | null, string | null, string | null, string | null]

export interface WireAggregateInputs {
  window_start: number
  window_seconds: number
  weights: HeatWeights // the H_e weight keys are already snake_case (sov, accel, rank_delta, …)
  min_samples_ready: number
  min_authors_full: number
  mentions_in_window: WireMentionRow[]
  prior_features: Record<string, { mentions: number | null; velocity: number | null }>
  prior_sov_ranks: Record<string, number>
  feature_history: [string, number, number][] // [ticker, window_start, mentions]
}

export interface WireFeature {
  ticker: string
  window_start: number
  mentions: number
  authors: number
  sov: number
  velocity: number | null
  accel: number | null
  z: number | null
  net_dir: number
  dd_count: number
  flair_counts: Record<string, number> // object (canonical sorted-key); oracle's json STRING is parsed to this in the diff
  baseline_status: string
  h_e: number
}

/** A fingerprint of the extractor's wordsets (per set: size + an FNV-1a hash of the sorted symbols). Lets
 *  replay detect a wordset mismatch (e.g. a regenerated `symbols.txt`) so a B3 DRIFT from a stale whitelist
 *  isn't misdiagnosed as a port bug (M4 review). FNV-1a is reproduced byte-identically in replay.py. */
export interface WordsetFingerprint {
  whitelist: { n: number; fnv: number } | null // null = no whitelist (open mode)
  stoplist: { n: number; fnv: number }
  ambiguous: { n: number; fnv: number }
}

/** One field where the PERSISTED Postgres row diverged from the in-memory board the gate verified. */
export interface ReadbackDiff {
  table: 'empirical' | 'analytical' | 'signals' | 'cycle_runs'
  ticker: string | null
  field: string
  in_memory: unknown
  persisted: unknown
}

/** Post-publish read-back result (M4 review): the persisted board re-read from Postgres, diffed EXACTLY
 *  (same engine — any difference is a write/coercion/marker bug) against the in-memory board just verified.
 *  Closes the write-path seam the replay can't see (it consumes the worker's reads, not its writes). */
export interface Readback {
  ok: boolean
  cycle_run: boolean // the cycle_runs publish marker for this window exists + is 'complete'
  diffs: ReadbackDiff[]
}

/**
 * One cycle's parity artifact. `inputs`+`features` are the B4 (aggregate) contract — replay feeds `inputs`
 * to the frozen scorer and diffs against `features` (values AND order). `poll`+`mentions` are the B3
 * (extract→classify→assemble) contract — replay runs `_mentions_from_poll` over `poll` and diffs `mentions`.
 * `readback` (when present) is the write-path check; `wordsets` lets replay verify B3 used the same wordlists.
 */
export interface CycleDump {
  schema_version: number
  window_start: number
  window_seconds: number
  generated_at: number
  capped: boolean
  newest_utc: number | null
  wordsets: WordsetFingerprint | null
  poll: { posts: WirePost[]; comments: WireComment[] }
  mentions: WireMention[] // sorted by (thing_id, ticker) — the B3 boundary order
  inputs: WireAggregateInputs
  features: WireFeature[] // the TS board, canonical order — ORDER IS PART OF THE CONTRACT
  readback: Readback | null
}

// --- wire mappers ----------------------------------------------------------------------------------

const post = (p: RawPostInsert): WirePost => ({
  id: p.id, created_utc: p.createdUtc ?? null, author: p.author ?? null, title: p.title ?? null,
  selftext: p.selftext ?? null, link_flair_text: p.linkFlairText ?? null, score: p.score ?? null,
  num_comments: p.numComments ?? null, retrieved_on: p.retrievedOn ?? null, source: p.source ?? null,
})

const comment = (c: RawCommentInsert): WireComment => ({
  id: c.id, created_utc: c.createdUtc ?? null, author: c.author ?? null, link_id: c.linkId ?? null,
  parent_id: c.parentId ?? null, body: c.body ?? null, score: c.score ?? null,
  retrieved_on: c.retrievedOn ?? null, source: c.source ?? null,
})

const mention = (m: MentionInsert): WireMention => ({
  ticker: m.ticker, thing_id: m.thingId, thing_type: m.thingType ?? null, created_utc: m.createdUtc ?? null,
  author: m.author ?? null, flair: m.flair ?? null, direction: m.direction ?? null,
})

const feature = (f: EmpiricalFeature): WireFeature => ({
  ticker: f.ticker, window_start: f.windowStart, mentions: f.mentions, authors: f.authors, sov: f.sov,
  velocity: f.velocity, accel: f.accel, z: f.z, net_dir: f.netDir, dd_count: f.ddCount,
  flair_counts: f.flairCounts, baseline_status: f.baselineStatus, h_e: f.hE,
})

const inputs = (i: AggregateInputs): WireAggregateInputs => ({
  window_start: i.windowStart, window_seconds: i.windowSeconds, weights: i.weights,
  min_samples_ready: i.minSamplesReady, min_authors_full: i.minAuthorsFull,
  mentions_in_window: i.mentionsInWindow.map((r) => [r[0], r[1], r[2], r[3], r[4], r[5]]),
  prior_features: Object.fromEntries(
    Object.entries(i.priorFeatures).map(([t, v]) => [t, { mentions: v.mentions, velocity: v.velocity }]),
  ),
  prior_sov_ranks: { ...i.priorSovRanks },
  feature_history: i.featureHistory.map((r) => [r[0], r[1], r[2]]),
})

export interface DumpParts {
  windowStart: number
  windowSeconds: number
  generatedAt: number
  capped: boolean
  newestUtc: number | null
  wordsets?: WordsetFingerprint | null
  poll: Pick<PollResult, 'posts' | 'comments'>
  mentions: readonly MentionInsert[]
  inputs: AggregateInputs
  features: readonly EmpiricalFeature[]
  readback?: Readback | null
}

/** Assemble the canonical cycle dump. `mentions` are sorted by (thing_id, ticker) here — the B3 boundary. */
export function buildCycleDump(p: DumpParts): CycleDump {
  const mentions = [...p.mentions].map(mention)
    .sort((a, b) => (a.thing_id < b.thing_id ? -1 : a.thing_id > b.thing_id ? 1
      : a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0))
  return {
    schema_version: SHADOW_SCHEMA_VERSION,
    window_start: p.windowStart,
    window_seconds: p.windowSeconds,
    generated_at: p.generatedAt,
    capped: p.capped,
    newest_utc: p.newestUtc,
    wordsets: p.wordsets ?? null,
    poll: { posts: p.poll.posts.map(post), comments: p.poll.comments.map(comment) },
    mentions,
    inputs: inputs(p.inputs),
    features: p.features.map(feature),
    readback: p.readback ?? null,
  }
}

// --- wordset fingerprint (FNV-1a 32-bit; reproduced byte-identically in oracle/replay.py) -----------

/** FNV-1a 32-bit hash of a string (deterministic, language-portable). Returns an unsigned 32-bit int.
 *  Uses `Math.imul` for the 32-bit prime multiply so it equals `(h * 0x01000193) mod 2³²` exactly —
 *  trivially reproduced in replay.py as `(h * 0x01000193) & 0xFFFFFFFF` (no JS int32-shift subtleties). */
export function fnv1a(s: string): number {
  let h = 0x811c_9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x0100_0193) >>> 0
  }
  return h >>> 0
}

/** Fingerprint one wordset: its size + an FNV-1a hash of the C-collation-sorted symbols joined by '\n'. */
export function fingerprintWordset(words: ReadonlySet<string>): { n: number; fnv: number } {
  const sorted = [...words].sort() // default JS sort = code-unit order = the C collation replay sorts by
  return { n: sorted.length, fnv: fnv1a(sorted.join('\n')) }
}

/** Fingerprint an extractor's three wordsets (whitelist null in open mode). */
export function fingerprintExtractor(
  w: { whitelist: ReadonlySet<string> | null; stop: ReadonlySet<string>; ambiguous: ReadonlySet<string> },
): WordsetFingerprint {
  return {
    whitelist: w.whitelist ? fingerprintWordset(w.whitelist) : null,
    stoplist: fingerprintWordset(w.stop),
    ambiguous: fingerprintWordset(w.ambiguous),
  }
}

// --- canonical JSON + atomic write -----------------------------------------------------------------

/** Recursively key-sort objects so the on-disk JSON is stable (arrays keep order — order is contract). */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k])
    }
    return out
  }
  return value
}

export function canonicalJson(obj: unknown): string {
  return `${JSON.stringify(sortKeys(obj), null, 2)}\n`
}

/** A sink the cycle calls with each dump; the worker wires it to `dumpCycle`, tests inject a capturer. */
export type ShadowSink = (dump: CycleDump) => void | Promise<void>

/** Atomically write a cycle dump to `<dir>/cycle-<window_start>.json` (temp + rename — no torn reads). */
export function dumpCycle(dir: string, dump: CycleDump): void {
  mkdirSync(dir, { recursive: true })
  const final = join(dir, `cycle-${dump.window_start}.json`)
  const tmp = `${final}.tmp`
  writeFileSync(tmp, canonicalJson(dump))
  renameSync(tmp, final)
}
