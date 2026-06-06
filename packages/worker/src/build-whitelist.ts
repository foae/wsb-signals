/**
 * build-whitelist CLI — TS port of `wsb_signals/cli.cmd_build_whitelist` (M5).
 * Fetches the Alpaca active us_equity universe → writes whitelist/symbols.txt
 * and (when DATABASE_URL is set) upserts company names into the ticker_names table.
 *
 *   pnpm -C packages/worker build-whitelist [--include-otc]
 */
import { join } from 'node:path'

import { buildWhitelist } from './assets'
import { findRoot, loadConfig } from './config'
import { createDb, migrateToLatest, upsertTickerNames } from './db'
import { log } from './logger'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const includeOtc = args.includes('--include-otc')

  const { raw, env, root } = loadConfig(findRoot())

  const key = env.ALPACA_API_KEY
  const secret = env.ALPACA_API_SECRET
  if (!key || !secret) {
    log.error('ALPACA_API_KEY / ALPACA_API_SECRET missing from environment — cannot build whitelist')
    process.exitCode = 1
    return
  }

  const endpointUrl = env.ALPACA_ENDPOINT_URL ?? 'https://paper-api.alpaca.markets/v2'
  const outPath = join(root, raw.extract.whitelist_path ?? 'whitelist/symbols.txt')
  const userAgent = raw.ingest.user_agent

  let assets: Array<[string, string]>
  try {
    assets = await buildWhitelist(key, secret, { endpointUrl, outPath, userAgent, includeOtc })
  } catch (err) {
    log.error({ err }, 'failed to fetch Alpaca assets')
    process.exitCode = 1
    return
  }

  if (env.DATABASE_URL) {
    try {
      const handle = createDb(env.DATABASE_URL)
      await migrateToLatest(handle.db)
      await upsertTickerNames(handle.db, assets.map(([symbol, name]) => ({ symbol, name })))
      await handle.close()
    } catch (err) {
      log.error({ err }, 'failed to upsert ticker_names — symbols.txt was written successfully')
      process.exitCode = 1
      return
    }
  } else {
    log.warn('DATABASE_URL not set — skipping ticker_names upsert (symbols.txt written)')
  }

  log.info({ count: assets.length, outPath }, 'wrote whitelist symbols (+ company names → ticker_names)')
}

main().catch((err) => {
  log.error({ err }, 'build-whitelist: unexpected error')
  process.exitCode = 1
})
