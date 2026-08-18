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
import { AiSdkAnalyzer, type PlayText } from './analyzer'
import { LlmExtractionSchema, type ExtractedPosition, type LlmExtraction } from './extraction'

const MARKING_CRITICAL = ['ticker', 'side', 'quantity', 'strike', 'expiry'] as const
const SCORED_FIELDS = [
  ...MARKING_CRITICAL, 'instrument', 'avg_price', 'cost_basis', 'current_value',
  'pnl_abs', 'pnl_pct', 'realized', 'opened_at', 'currency',
] as const
type ScoredField = (typeof SCORED_FIELDS)[number]

/** Exact match per field; numbers within 0.5 % (broker rounding); null==null is CORRECT. */
export function fieldMatches(expected: unknown, actual: unknown): boolean {
  if (expected == null || actual == null) return expected == null && actual == null
  if (typeof expected === 'number' && typeof actual === 'number') {
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
}

/** Score one case: positions aligned by index (the answer key is labeled in gallery/screen order —
 *  the same order the prompt demands). A missing/extra position counts every field wrong. */
export function scoreCase(name: string, expected: LlmExtraction, actual: LlmExtraction): CaseScore {
  const perField = Object.fromEntries(
    SCORED_FIELDS.map((f) => [f, { correct: 0, total: 0 }]),
  ) as CaseScore['perField']
  const n = Math.max(expected.positions.length, actual.positions.length)
  for (let i = 0; i < n; i++) {
    const e = expected.positions[i]
    const a = actual.positions[i]
    for (const f of SCORED_FIELDS) {
      perField[f].total++
      if (e && a && fieldMatches(e[f as keyof ExtractedPosition], a[f as keyof ExtractedPosition])) {
        perField[f].correct++
      }
    }
  }
  return {
    name,
    positionsExpected: expected.positions.length,
    positionsActual: actual.positions.length,
    perField,
    kindOk: expected.screenshot_kind === actual.screenshot_kind,
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
  const apiKey = env.OPENAI_API_KEY
  if (!apiKey) {
    log.error('OPENAI_API_KEY missing — plays-eval makes real paid calls')
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

  const analyzer = new AiSdkAnalyzer({
    provider: worker.plays.llm.provider, model, maxOutputTokens: worker.plays.llm.maxOutputTokens, apiKey,
  })
  const scores: CaseScore[] = []
  for (const name of cases) {
    const dir = join(fixturesDir, name)
    const text = JSON.parse(readFileSync(join(dir, 'post.json'), 'utf8')) as PlayText
    const expected = LlmExtractionSchema.parse(JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')))
    const imagesDir = join(dir, 'images')
    const images = readdirSync(imagesDir).sort().map((f) => ({
      data: Buffer.from(readFileSync(join(imagesDir, f))),
      mediaType: f.endsWith('.png') ? 'image/png' : 'image/jpeg',
    }))
    const result = await analyzer.extract(images, text)
    const score = scoreCase(name, expected, result.extraction)
    scores.push(score)
    log.info({ case: name, positions: `${score.positionsActual}/${score.positionsExpected}`, kindOk: score.kindOk }, 'case scored')
  }
  log.info({ model, cases: scores.length, accuracy: summarize(scores) }, 'plays-eval complete')
}

// Invoked as a CLI (package script `plays-eval`); importable for the scorer unit tests.
if (process.argv[1]?.endsWith('eval.ts') || process.argv[1]?.endsWith('eval.js')) {
  main().catch((e) => {
    log.error({ err: String(e) }, 'plays-eval: unexpected error')
    process.exitCode = 1
  })
}
