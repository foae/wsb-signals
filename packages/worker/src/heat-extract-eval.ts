/** Repeatable labeled precision/recall gate for the radar ticker extractor. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { findRoot, loadConfig } from './config'
import { loadWordset, TickerExtractor } from './extract'

interface LabeledCase {
  id: string
  text: string
  expected: string[]
}

interface Fixture {
  schema_version: string
  universe: string[]
  cases: LabeledCase[]
}

export interface HeatExtractionEval {
  schemaVersion: string
  cases: number
  exactCases: number
  truePositive: number
  falsePositive: number
  falseNegative: number
  precision: number
  recall: number
  mismatches: Array<{ id: string; expected: string[]; actual: string[] }>
}

export function evaluateHeatExtraction(root = findRoot()): HeatExtractionEval {
  const { raw } = loadConfig(root)
  const fixture = JSON.parse(readFileSync(
    join(root, 'fixtures', 'heat', 'extraction-labelled.json'), 'utf8',
  )) as Fixture
  const stop = loadWordset(readFileSync(join(root, raw.extract.stoplist_path), 'utf8'))
  const ambiguous = raw.extract.ambiguous_path
    ? loadWordset(readFileSync(join(root, raw.extract.ambiguous_path), 'utf8'))
    : new Set<string>()
  const extractor = new TickerExtractor(stop, {
    regex: new RegExp(raw.extract.candidate_regex, 'g'),
    whitelist: new Set(fixture.universe),
    ambiguous,
  })

  let truePositive = 0
  let falsePositive = 0
  let falseNegative = 0
  const mismatches: HeatExtractionEval['mismatches'] = []
  for (const row of fixture.cases) {
    const expected = [...new Set(row.expected)].sort()
    const actual = [...new Set(extractor.extract(row.text))].sort()
    const expectedSet = new Set(expected)
    const actualSet = new Set(actual)
    truePositive += actual.filter((ticker) => expectedSet.has(ticker)).length
    falsePositive += actual.filter((ticker) => !expectedSet.has(ticker)).length
    falseNegative += expected.filter((ticker) => !actualSet.has(ticker)).length
    if (expected.join(',') !== actual.join(',')) mismatches.push({ id: row.id, expected, actual })
  }

  return {
    schemaVersion: fixture.schema_version,
    cases: fixture.cases.length,
    exactCases: fixture.cases.length - mismatches.length,
    truePositive,
    falsePositive,
    falseNegative,
    precision: truePositive / Math.max(1, truePositive + falsePositive),
    recall: truePositive / Math.max(1, truePositive + falseNegative),
    mismatches,
  }
}

function main(): void {
  const result = evaluateHeatExtraction()
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (result.mismatches.length) process.exitCode = 1
}

if (process.argv[1]?.endsWith('heat-extract-eval.ts') || process.argv[1]?.endsWith('heat-extract-eval.js')) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`heat-extract-eval: ${String(error)}\n`)
    process.exitCode = 1
  }
}
