/**
 * Ticker whitelist builder — TS port of the frozen v0.0.1 `wsb_signals/assets.py`
 * (porting-spec §4 extension, M5). Fetches the Alpaca active us_equity universe,
 * dedupes by symbol (first occurrence wins), and writes `symbols.txt` for the extractor.
 *
 * Parity notes:
 *  - `tradable:false` rows are dropped (Python `if not a.get("tradable"): continue`).
 *  - OTC rows are dropped by default (`!includeOtc && a.exchange === 'OTC'`).
 *  - Deduplication is first-occurrence-wins (Python `if sym not in by_sym`).
 *  - Output is sorted ascending by symbol (code-point order — Python `sorted(by_sym.items())`).
 *  - Non-200 throws (Python `resp.raise_for_status()`).
 *  - Manual AbortController timeout (same pattern as ingest.ts `get`).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { fetch } from 'undici'

import { log } from './logger'

export async function fetchAlpacaAssets(
  key: string,
  secret: string,
  opts: {
    endpointUrl: string
    userAgent?: string
    includeOtc?: boolean
    timeoutMs?: number
  },
): Promise<Array<[string, string]>> {
  const {
    endpointUrl,
    userAgent = 'wsb-signals/0.0.1',
    includeOtc = false,
    timeoutMs = 60_000,
  } = opts

  const base = endpointUrl.replace(/\/+$/, '')
  const url = `${base}/assets?status=active&asset_class=us_equity`

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
  timer.unref?.()

  let res: Awaited<ReturnType<typeof fetch>>
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        'APCA-API-KEY-ID': key,
        'APCA-API-SECRET-KEY': secret,
        'User-Agent': userAgent,
      },
      signal: ac.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (res.status !== 200) {
    const body = await res.text().catch(() => '')
    throw new Error(`Alpaca /assets returned HTTP ${res.status}: ${body.slice(0, 200)}`)
  }

  const data = (await res.json()) as Array<Record<string, unknown>>

  const bySym: Map<string, string> = new Map()
  for (const a of data) {
    if (!a['tradable']) continue
    if (!includeOtc && a['exchange'] === 'OTC') continue
    const sym = String(a['symbol'] ?? '').trim()
    if (sym && !bySym.has(sym)) {
      bySym.set(sym, String(a['name'] ?? '').trim())
    }
  }

  // Sort ascending by symbol (code-point order — Python `sorted(by_sym.items())`)
  const pairs: Array<[string, string]> = [...bySym.entries()]
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return pairs
}

export async function buildWhitelist(
  key: string,
  secret: string,
  opts: {
    endpointUrl: string
    outPath: string
    userAgent?: string
    includeOtc?: boolean
  },
): Promise<Array<[string, string]>> {
  const { endpointUrl, outPath, userAgent, includeOtc = false } = opts

  log.info({ endpointUrl }, 'fetching Alpaca asset universe…')
  const assets = await fetchAlpacaAssets(key, secret, { endpointUrl, userAgent, includeOtc })

  mkdirSync(dirname(outPath), { recursive: true })

  const suffix = includeOtc ? '' : ' (non-OTC)'
  const header =
    `# Ticker whitelist — Alpaca active, tradable us_equity${suffix}.\n` +
    '# DERIVED + refreshable, gitignored. Regenerate weekly: `pnpm -C packages/worker build-whitelist`.\n' +
    '# One symbol per line; company names live in the ticker_names table. See architecture §2.2.\n'

  const symbols = assets.map(([sym]) => sym)
  writeFileSync(outPath, header + symbols.join('\n') + '\n', 'utf8')

  return assets
}
