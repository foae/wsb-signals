/**
 * Config + dependency wiring — TS port of `config.Settings` + the `cli._build_*` factories
 * (porting-spec §10). Tunables come from the SAME committed `config.toml` (parity); secrets come from
 * the environment (`.env` overlaid by real env vars, so containers/k8s inject creds — Python's
 * `os.environ` overlay). Nothing here is on the scoring hot path; it just assembles the worker.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { parse as parseToml } from 'smol-toml'

import type { HeatWeights } from './aggregate'
import type { SignalsConfig } from './analytics'
import { loadWordset, TickerExtractor } from './extract'
import { ArcticShiftSource } from './ingest'
import { log } from './logger'
import { AlpacaMarketData, type MarketData, type MarketWeights } from './market'
import type { AggregateConfig, MarketConfig } from './pipeline'

/** The committed config.toml shape (only the fields the worker reads). */
interface RawConfig {
  ingest: {
    subreddit: string
    poll_seconds: number
    min_poll_gap_seconds: number
    window_seconds: number
    max_pages: number
    page_limit: number
    request_timeout: number
    user_agent: string
  }
  sources: { arctic_shift: { base_url: string } }
  extract: {
    candidate_regex: string
    stoplist_path: string
    whitelist_path?: string
    ambiguous_path?: string
    bots: string[]
  }
  heat: { min_authors_full: number; min_window_mentions: number; weights: HeatWeights }
  baseline: { min_samples_ready: number; lookback_seconds: number }
  market: { feed: string; top_n: number; screener_top: number; weights: MarketWeights }
  signals: {
    median_lookback_seconds: number
    min_quadrant_population: number
    lead_lag: {
      enabled: boolean
      lookback_seconds: number
      max_lag_windows: number
      min_pairs: number
      min_corr: number
    }
  }
  heartbeat: { max_staleness_seconds: number }
  storage: { data_dir: string }
}

/** The flattened, typed config the loop/cycle consume. */
export interface WorkerConfig {
  windowSeconds: number
  pollSeconds: number
  minPollGapSeconds: number
  minWindowMentions: number
  maxStalenessSeconds: number
  bots: Set<string>
  dataDir: string
  aggregate: AggregateConfig
  market: MarketConfig
  signals: SignalsConfig
}

export interface LoadedConfig {
  raw: RawConfig
  env: Record<string, string>
  worker: WorkerConfig
  root: string
}

/** Tiny `.env` reader (KEY=VALUE, # comments, optional quotes) — mirrors `config.load_env`. */
function readDotenv(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const path = join(root, '.env')
  if (!existsSync(path)) return out
  for (const raw of readFileSync(path, 'utf8').split(/\r\n|\r|\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const eq = line.indexOf('=')
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
  }
  return out
}

/**
 * Resolve the project root (the dir holding `config.toml`) independent of the invocation cwd. Necessary
 * because the documented run commands and the container both start the worker with cwd =
 * `packages/worker` (`pnpm -C packages/worker …` runs scripts there; the image runs from
 * `/app/packages/worker`), neither of which holds `config.toml`/`whitelist/` — those live at the repo
 * root. Honors an explicit `WSB_ROOT` override (set in the image), else walks up from `start` to the first
 * dir containing `config.toml`, else returns `start` (loadConfig then surfaces a clear ENOENT).
 */
export function findRoot(start: string = process.cwd()): string {
  // WSB_ROOT is a hint, honored ONLY if it actually holds config.toml — a stale or relative override
  // shouldn't silently break resolution; fall through to the walk-up instead.
  const override = process.env.WSB_ROOT
  if (override && existsSync(join(override, 'config.toml'))) return override
  let dir = start
  for (;;) {
    if (existsSync(join(dir, 'config.toml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return start // reached the filesystem root without finding it
    dir = parent
  }
}

export function loadConfig(root: string): LoadedConfig {
  const raw = parseToml(readFileSync(join(root, 'config.toml'), 'utf8')) as unknown as RawConfig
  // Real env vars WIN over the .env file (container-native secrets — Python overlays os.environ).
  const env: Record<string, string> = { ...readDotenv(root) }
  for (const [k, v] of Object.entries(process.env)) if (v != null) env[k] = v

  const worker: WorkerConfig = {
    windowSeconds: raw.ingest.window_seconds,
    pollSeconds: raw.ingest.poll_seconds,
    minPollGapSeconds: raw.ingest.min_poll_gap_seconds,
    minWindowMentions: raw.heat.min_window_mentions,
    maxStalenessSeconds: raw.heartbeat.max_staleness_seconds,
    bots: new Set(raw.extract.bots),
    dataDir: join(root, raw.storage.data_dir),
    aggregate: {
      windowSeconds: raw.ingest.window_seconds,
      weights: raw.heat.weights,
      minSamplesReady: raw.baseline.min_samples_ready,
      baselineLookbackSeconds: raw.baseline.lookback_seconds,
      minAuthorsFull: raw.heat.min_authors_full,
    },
    market: {
      topN: raw.market.top_n,
      screenerTop: raw.market.screener_top,
      weights: raw.market.weights,
    },
    signals: {
      medianLookbackSeconds: raw.signals.median_lookback_seconds,
      minQuadrantPopulation: raw.signals.min_quadrant_population,
      leadLag: {
        enabled: raw.signals.lead_lag.enabled,
        lookbackSeconds: raw.signals.lead_lag.lookback_seconds,
        maxLagWindows: raw.signals.lead_lag.max_lag_windows,
        minPairs: raw.signals.lead_lag.min_pairs,
        minCorr: raw.signals.lead_lag.min_corr,
      },
    },
  }
  return { raw, env, worker, root }
}

/**
 * Build the ticker extractor — port of `cli._build_extractor`. Fails CLOSED: a configured-but-missing
 * whitelist degrades to CASHTAG-ONLY (bare tokens rejected), never to bare-token extraction (which would
 * flood the board with uppercase non-tickers). A missing ambiguous file just disables that gate.
 */
export function buildExtractor(raw: RawConfig, root: string): TickerExtractor {
  const stop = loadWordset(readFileSync(join(root, raw.extract.stoplist_path), 'utf8'))
  const regex = new RegExp(raw.extract.candidate_regex, 'g')

  const wlPath = raw.extract.whitelist_path ? join(root, raw.extract.whitelist_path) : null
  if (wlPath && !existsSync(wlPath)) {
    log.warn({ whitelist: wlPath }, 'whitelist configured but missing — running CASHTAG-ONLY until `build-whitelist`')
    return TickerExtractor.cashtagOnly(stop, { regex })
  }
  const whitelist = wlPath ? loadWordset(readFileSync(wlPath, 'utf8')) : null

  const ambPath = raw.extract.ambiguous_path ? join(root, raw.extract.ambiguous_path) : null
  const ambiguous = ambPath && existsSync(ambPath) ? loadWordset(readFileSync(ambPath, 'utf8')) : null

  return new TickerExtractor(stop, { regex, whitelist, ambiguous })
}

/** Port of `cli._arctic_source`. */
export function buildSource(raw: RawConfig): ArcticShiftSource {
  const ing = raw.ingest
  return new ArcticShiftSource(raw.sources.arctic_shift.base_url, ing.subreddit, {
    pageLimit: ing.page_limit,
    maxPages: ing.max_pages,
    userAgent: ing.user_agent,
    timeoutMs: ing.request_timeout * 1000,
  })
}

/** Port of `cli._market_client` — null when ALPACA creds are absent (empirical-only). */
export function buildMarket(raw: RawConfig, env: Record<string, string>): MarketData | null {
  const key = env.ALPACA_API_KEY
  const secret = env.ALPACA_API_SECRET
  if (!key || !secret) return null
  return new AlpacaMarketData(key, secret, {
    dataUrl: env.ALPACA_DATA_URL ?? 'https://data.alpaca.markets',
    feed: raw.market.feed,
    userAgent: raw.ingest.user_agent,
  })
}
