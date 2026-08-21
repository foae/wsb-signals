/**
 * `analyze` — thin HTTP client for the deployed read-only analysis API.
 * JSON goes to stdout; diagnostics go to stderr so agents can pipe results into jq or files.
 */
import { pathToFileURL } from 'node:url'

import {
  analysisBaseUrl, assertOptions, getJson, parseArgs, parseEpoch, stringOption,
} from './client'

const USAGE = `Usage:
  pnpm -C packages/worker analyze -- catalog [--base-url URL] [--pretty]
  pnpm -C packages/worker analyze -- ticker TICKER [--from TIME] [--to TIME] [--base-url URL] [--pretty]
  pnpm -C packages/worker analyze -- play REDDIT_ID [--before-hours N] [--after-hours N] [--base-url URL] [--pretty]

TIME is Unix seconds or ISO-8601 between 2010-01-01 and 2100-01-01. Ranges are [from,to); date-only values mean UTC midnight.`


export async function runAnalyze(argv: readonly string[]): Promise<unknown> {
  const { positionals, options } = parseArgs(argv)
  const command = positionals[0]
  const base = analysisBaseUrl(options)
  const params = new URLSearchParams()

  if (command === 'catalog') {
    assertOptions(options, ['base-url', 'pretty'])
    if (positionals.length !== 1) throw new Error('catalog takes no positional arguments')
    return getJson(base, '/api/analysis', params)
  }

  if (command === 'ticker') {
    assertOptions(options, ['from', 'to', 'base-url', 'pretty'])
    if (positionals.length !== 2) throw new Error('ticker requires exactly one ticker symbol')
    const from = stringOption(options, 'from')
    const to = stringOption(options, 'to')
    if (from != null) params.set('from', String(parseEpoch(from, '--from')))
    if (to != null) params.set('to', String(parseEpoch(to, '--to')))
    return getJson(base, `/api/analysis/tickers/${encodeURIComponent(positionals[1]!)}`, params)
  }

  if (command === 'play') {
    assertOptions(options, ['before-hours', 'after-hours', 'base-url', 'pretty'])
    if (positionals.length !== 2) throw new Error('play requires exactly one Reddit post id')
    const before = stringOption(options, 'before-hours')
    const after = stringOption(options, 'after-hours')
    if (before != null) params.set('beforeHours', before)
    if (after != null) params.set('afterHours', after)
    return getJson(base, `/api/analysis/plays/${encodeURIComponent(positionals[1]!)}`, params)
  }

  throw new Error(command == null ? USAGE : `unknown command ${JSON.stringify(command)}\n${USAGE}`)
}

async function main(): Promise<void> {
  try {
    const output = await runAnalyze(process.argv.slice(2))
    const pretty = process.argv.includes('--pretty')
    process.stdout.write(`${JSON.stringify(output, null, pretty ? 2 : 0)}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main()
