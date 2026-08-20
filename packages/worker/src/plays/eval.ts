/**
 * `plays-eval` (P2, plays-plan §4) — run the REAL extractor over the hand-labeled fixture set and
 * machine-score a field-by-field diff. This harness is the model-choice instrument: repeatable
 * across model swaps, which is exactly why scoring is mechanical (a correct `null` scores as
 * correct; per-field accuracy reported, never one blended number). A manual quality gate, not CI —
 * CI covers the seam with the injected fake.
 *
 * Fixture layout (see fixtures/plays/README.md; ≥ 30 cases before trusting percentages):
 *   fixtures/plays/<case>/post.json      { title, selftext, flair }
 *   fixtures/plays/<case>/expected.json  hand-labeled LlmExtraction (the answer key)
 *   fixtures/plays/<case>/images/*.jpg   redacted screenshots, gallery order by filename
 *
 * Marking-critical fields (ticker/side/quantity/strike/expiry — what P5's money math consumes) get
 * their own accuracy lines: an aggregate 80 % can pass while every expiry is wrong.
 *
 * Usage: OPENAI_API_KEY=… pnpm -C packages/worker plays-eval [--model <id>]
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { findRoot, loadConfig } from '../config'
import { log } from '../logger'
import { buildAnalyzer, type PlayText } from './analyzer'
import { LlmExtractionSchema, type ExtractedPosition, type LlmExtraction } from './extraction'
import { encodeForLlm } from './images'
import { costUsd, usablePrices } from './metering'

const MARKING_CRITICAL = ['ticker', 'side', 'quantity', 'strike', 'expiry'] as const
const SCORED_FIELDS = [
  ...MARKING_CRITICAL, 'instrument', 'avg_price', 'cost_basis', 'current_value',
  'pnl_abs', 'pnl_pct', 'realized', 'opened_at', 'currency',
] as const
type ScoredField = (typeof SCORED_FIELDS)[number]

/** Exact match per field; non-integer numbers within 0.5 % (broker rounding — integers like
 *  quantity are EXACT: 200 vs 201 contracts is a real error); null==null is CORRECT. */
export function fieldMatches(expected: unknown, actual: unknown): boolean {
  if (expected == null || actual == null) return expected == null && actual == null
  if (typeof expected === 'number' && typeof actual === 'number') {
    if (Number.isInteger(expected) && Number.isInteger(actual)) return expected === actual
    return expected === actual || Math.abs(expected - actual) <= Math.abs(expected) * 0.005
  }
  return expected === actual
}

export interface CaseScore {
  name: string
  /** expected-vs-actual position-count match — misaligned cases score their overlap only. */
  positionsExpected: number
  positionsActual: number
  perField: Record<ScoredField, { correct: number; total: number }>
  kindOk: boolean
  /** Human-readable `leg.field: expected ≠ actual` lines — the tuning loop's raw material. */
  mismatches: string[]
}

/** Canonical leg order for scoring: reversed-but-identical spread legs must not score every field
 *  wrong — the prompt asks for screen order but does not (cannot) guarantee it (review round 1). */
const canonical = (positions: readonly ExtractedPosition[]): ExtractedPosition[] =>
  [...positions].sort((a, b) =>
    a.ticker.localeCompare(b.ticker) || a.instrument.localeCompare(b.instrument)
    || a.side.localeCompare(b.side) || (a.strike ?? 0) - (b.strike ?? 0)
    || (a.expiry ?? '').localeCompare(b.expiry ?? ''))

/** `currency: null` MEANS USD by schema convention ("null = assume USD") — an explicit "USD" and
 *  a null are the same answer, and scoring them apart penalized correct extractions (eval round 2:
 *  13 phantom currency misses on screens that print "USD" next to every figure). */
const normField = (f: ScoredField, v: unknown): unknown => (f === 'currency' && v == null ? 'USD' : v)

/** Score one case: both sides sorted canonically, then paired. A missing/extra position counts
 *  every field wrong. */
export function scoreCase(name: string, expected: LlmExtraction, actual: LlmExtraction): CaseScore {
  const perField = Object.fromEntries(
    SCORED_FIELDS.map((f) => [f, { correct: 0, total: 0 }]),
  ) as CaseScore['perField']
  const exp = canonical(expected.positions)
  const act = canonical(actual.positions)
  const n = Math.max(exp.length, act.length)
  const mismatches: string[] = []
  for (let i = 0; i < n; i++) {
    const e = exp[i]
    const a = act[i]
    for (const f of SCORED_FIELDS) {
      perField[f].total++
      const ev = e?.[f as keyof ExtractedPosition]
      const av = a?.[f as keyof ExtractedPosition]
      if (e && a && fieldMatches(normField(f, ev), normField(f, av))) perField[f].correct++
      else mismatches.push(`leg${i}.${f}: ${JSON.stringify(ev ?? '<missing>')} ≠ ${JSON.stringify(av ?? '<missing>')}`)
    }
  }
  if (expected.screenshot_kind !== actual.screenshot_kind) {
    mismatches.push(`screenshot_kind: ${expected.screenshot_kind} ≠ ${actual.screenshot_kind}`)
  }
  return {
    name,
    positionsExpected: expected.positions.length,
    positionsActual: actual.positions.length,
    perField,
    kindOk: expected.screenshot_kind === actual.screenshot_kind,
    mismatches,
  }
}

export function summarize(scores: readonly CaseScore[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of SCORED_FIELDS) {
    const correct = scores.reduce((s, c) => s + c.perField[f].correct, 0)
    const total = scores.reduce((s, c) => s + c.perField[f].total, 0)
    const pct = total ? ((100 * correct) / total).toFixed(1) : 'n/a'
    const critical = (MARKING_CRITICAL as readonly string[]).includes(f) ? ' [MARKING-CRITICAL]' : ''
    out[f] = `${pct}% (${correct}/${total})${critical}`
  }
  const kinds = scores.filter((s) => s.kindOk).length
  out.screenshot_kind = `${((100 * kinds) / Math.max(scores.length, 1)).toFixed(1)}% (${kinds}/${scores.length})`
  const aligned = scores.filter((s) => s.positionsExpected === s.positionsActual).length
  out.position_count = `${((100 * aligned) / Math.max(scores.length, 1)).toFixed(1)}% (${aligned}/${scores.length})`
  return out
}

async function main(): Promise<void> {
  const root = findRoot(process.cwd())
  const { worker, env } = loadConfig(root)
  const modelFlagIdx = process.argv.indexOf('--model')
  const model = modelFlagIdx > -1 ? process.argv[modelFlagIdx + 1]! : worker.plays.llm.extractModel
  const analyzer = buildAnalyzer(
    { provider: worker.plays.llm.provider, model, maxOutputTokens: worker.plays.llm.maxOutputTokens }, env)
  if (!analyzer) {
    log.error('no analyzer credentials — plays-eval makes real calls (OPENAI_API_KEY or CODEX_AUTH_FILE per provider)')
    process.exitCode = 1
    return
  }
  // Same fail-closed rule as production dispatch (invariant P6): no usable price, no calls. Eval
  // spend is deliberately NOT written to the production daily cap (an operator-run gate must not
  // park the pipeline), so the price + the running total below are its whole meter — keep both.
  const prices = usablePrices(worker.plays.llm, model)
  if (!prices) {
    log.error({ model }, 'no usable price in [plays.llm.prices] — set real prices before running the eval (never free)')
    process.exitCode = 1
    return
  }
  const fixturesDir = join(root, 'fixtures', 'plays')
  let cases: string[]
  try {
    cases = readdirSync(fixturesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  } catch {
    log.error({ fixturesDir }, 'no fixtures/plays/ directory — collect + label cases first (see its README)')
    process.exitCode = 1
    return
  }
  if (cases.length < 30) {
    log.warn({ cases: cases.length }, 'fewer than 30 cases — percentages carry ±20-point confidence intervals; collect more before trusting this run')
  }

  const scores: CaseScore[] = []
  let spentUsd = 0
  for (const name of cases) {
    const dir = join(fixturesDir, name)
    const text = JSON.parse(readFileSync(join(dir, 'post.json'), 'utf8')) as PlayText
    const expected = LlmExtractionSchema.parse(JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')))
    const imagesDir = join(dir, 'images')
    // The PRODUCTION encoding (images.ts) — scoring raw fixtures would measure the model on
    // inputs production never sends.
    const images = await Promise.all(
      readdirSync(imagesDir).sort().map(async (f) => encodeForLlm(Buffer.from(readFileSync(join(imagesDir, f))))))
    // Per-case boundary: one crashing extraction (provider hiccup, schema violation) scores as a
    // fully-empty answer instead of killing the run — a model that fails a case must PAY for it in
    // the accuracy table, not hide it by aborting the eval.
    let actual: LlmExtraction = { screenshot_kind: 'none', broker: null, positions: [], notes: null, confidence: null }
    try {
      const result = await analyzer.extract(images, text)
      actual = result.extraction
      const caseCost = result.usage.inputTokens != null && result.usage.outputTokens != null
        ? costUsd(prices, result.usage.inputTokens, result.usage.outputTokens)
        : 0
      spentUsd += caseCost
    } catch (e) {
      log.error({ case: name, err: String(e).slice(0, 200) }, 'case extraction FAILED — scored as empty')
    }
    const score = scoreCase(name, expected, actual)
    scores.push(score)
    log.info({
      case: name, positions: `${score.positionsActual}/${score.positionsExpected}`, kindOk: score.kindOk,
      ...(score.mismatches.length ? { mismatches: score.mismatches } : {}),
      spentUsd: Number(spentUsd.toFixed(4)),
    }, 'case scored')
  }
  log.info({ model, cases: scores.length, spentUsd: Number(spentUsd.toFixed(4)), accuracy: summarize(scores) },
    'plays-eval complete')
}

// Invoked as a CLI (package script `plays-eval`); importable for the scorer unit tests.
if (process.argv[1]?.endsWith('eval.ts') || process.argv[1]?.endsWith('eval.js')) {
  main().catch((e) => {
    log.error({ err: String(e) }, 'plays-eval: unexpected error')
    process.exitCode = 1
  })
}
