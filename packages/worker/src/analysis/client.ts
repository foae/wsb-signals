/** Small, dependency-free client helpers shared by the agent analysis CLIs. */

import {
  ANALYSIS_MAX_EPOCH_SECONDS, ANALYSIS_MIN_EPOCH_SECONDS, ANALYSIS_QUERY_TIMEOUT_SECONDS,
} from '@wsb/shared'

export interface ParsedArgs {
  positionals: string[]
  options: Map<string, string | true>
}
const DEFAULT_BOOLEAN_FLAGS: Readonly<Record<string, true>> = { pretty: true }


export function parseArgs(
  argv: readonly string[],
  booleanFlags: Readonly<Record<string, true>> = DEFAULT_BOOLEAN_FLAGS,
): ParsedArgs {
  const positionals: string[] = []
  const options = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--') continue // pnpm forwards its argument delimiter to tsx scripts
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const key = arg.slice(2)
    if (!key) throw new Error('empty option name')
    if (options.has(key)) throw new Error(`duplicate option --${key}`)
    if (booleanFlags[key] === true) {
      options.set(key, true)
      continue
    }
    const value = argv[++i]
    if (value == null || value.startsWith('--')) throw new Error(`--${key} requires a value`)
    options.set(key, value)
  }
  return { positionals, options }
}

export function assertOptions(options: Map<string, string | true>, allowed: readonly string[]): void {
  const allow = new Set(allowed)
  for (const key of options.keys()) if (!allow.has(key)) throw new Error(`unknown option --${key}`)
}

export function stringOption(options: Map<string, string | true>, key: string): string | undefined {
  const value = options.get(key)
  return typeof value === 'string' ? value : undefined
}

/** Recent Unix seconds or an ISO-8601 timestamp/date; date-only means UTC midnight. */
export function parseEpoch(value: string, label: string): number {
  const millis = /^\d+$/.test(value) ? Number.NaN : Date.parse(value)
  const seconds = Number.isNaN(millis) ? Number(value) : Math.floor(millis / 1000)
  if (
    Number.isSafeInteger(seconds)
    && seconds >= ANALYSIS_MIN_EPOCH_SECONDS
    && seconds <= ANALYSIS_MAX_EPOCH_SECONDS
  ) return seconds
  throw new Error(`${label} must be Unix seconds or ISO-8601 between 2010-01-01 and 2100-01-01`)
}

export function analysisBaseUrl(options: Map<string, string | true>): URL {
  const raw = stringOption(options, 'base-url') ?? process.env.WSB_ANALYSIS_URL ?? 'http://localhost:3000'
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('--base-url must use http or https')
  return url
}

export async function getJson(base: URL, path: string, params: URLSearchParams): Promise<unknown> {
  const url = new URL(path, base)
  url.search = params.toString()
  let response: Response
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(ANALYSIS_QUERY_TIMEOUT_SECONDS * 1000),
    })
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new Error(`request timed out after ${ANALYSIS_QUERY_TIMEOUT_SECONDS}s: ${url.pathname}`, { cause: error })
    }
    throw error
  }
  const text = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url.pathname}: ${text.slice(0, 500)}`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`HTTP ${response.status} ${url.pathname}: response was not JSON`)
  }
}
