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
    max_retries?: number
    retry_backoff_ms?: number
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
  plays: {
    enabled: boolean
    flairs: string[]
    queue_interval_s: number
    capture_delay_minutes?: number
    text_only_min_chars?: number
    max_attempts: number
    lease_minutes: number
    media_retry_minutes: number
    max_images_stored: number
    max_images_llm: number
    max_image_mb: number
    max_request_mb: number
    reddit_user_agent: string
    llm: {
      provider: string
      extract_model: string
      interpret_model: string
      max_plays_per_tick: number
      max_output_tokens: number
      daily_budget_usd: number
      prices: Record<string, { input: number; output: number }>
    }
    herd: {
      lookback_hours: number
      min_authors: number
    }
    evidence?: {
      heat_staleness_hours?: number
    }
  }
}

/** Per-model $/Mtok — the metering source of truth (invariant P6). Zero/missing = REFUSE dispatch. */
export interface LlmPrices {
  input: number
  output: number
}

/** LLM stage knobs (plays-plan §9, [plays.llm]). */
export interface PlaysLlmConfig {
  /** AI-SDK provider id ("openai"; "anthropic" etc. later — config-only swap). */
  provider: string
  extractModel: string
  interpretModel: string
  maxPlaysPerTick: number
  /** Per call — also the worst-case pre-dispatch cost reservation (metering.ts). */
  maxOutputTokens: number
  /** UTC day; the counter is summed from cost_usd rows in the DB, never in-memory. */
  dailyBudgetUsd: number
  prices: Record<string, LlmPrices>
}

/** Flattened plays capture + queue + LLM config (plays-plan §9). */
export interface PlaysConfig {
  enabled: boolean
  flairs: Set<string>
  queueIntervalSeconds: number
  /** Posts younger than this are NOT captured yet (the poll re-delivers them ~12×/h, so they enqueue
   *  once old enough). Lets WSB mods remove junk first — no media fetch or LLM spend on posts that
   *  don't survive their first minutes (user decision 2026-08-20; default 15 min). */
  captureDelaySeconds: number
  /** A post with NO resolvable media needs at least this much selftext to be captured — a bare title
   *  can't yield positions, so thinner text-only posts never reach the LLM (user decision 2026-08-20). */
  textOnlyMinChars: number
  maxAttempts: number
  leaseSeconds: number
  mediaRetrySeconds: number
  maxImagesStored: number
  /** ≤ this many images per LLM request (the first N in gallery order — product §4.1). */
  maxImagesLlm: number
  maxImageBytes: number
  /** Total image bytes per LLM request (memory + provider limits, plays-plan §1). */
  maxRequestBytes: number
  redditUserAgent: string
  /** Absolute media root — files land at `<mediaDir>/<post_id>/<n>.<ext>` (the shared volume). */
  mediaDir: string
  llm: PlaysLlmConfig
  /** The herd gate (plays-plan §9 [plays.herd]; invariant P4): `herd-following` is offered to the
   *  model only at/above `minAuthors` distinct same-direction authors in the lookback. */
  herd: {
    lookbackHours: number
    minAuthors: number
  }
  /** Staleness bound for the radar heat chip ([plays.evidence].heat_staleness_hours, default 6 h):
   *  a complete window older than this vs the anchor reads "heat evidence unavailable". */
  heatStalenessSeconds: number
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
  plays: PlaysConfig
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
  // Required since P1 — fail with a clear message, not a TypeError deep in the flattening below.
  if (!raw.plays) throw new Error("config.toml is missing the [plays] section (required since P1 — see plays-plan §9)")
  if (!raw.plays.llm) throw new Error("config.toml is missing the [plays.llm] section (required since P2 — see plays-plan §9)")
  if (!raw.plays.herd) throw new Error("config.toml is missing the [plays.herd] section (required since P3 — see plays-plan §9)")
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
    plays: {
      enabled: raw.plays.enabled,
      flairs: new Set(raw.plays.flairs),
      queueIntervalSeconds: raw.plays.queue_interval_s,
      captureDelaySeconds: (raw.plays.capture_delay_minutes ?? 15) * 60,
      textOnlyMinChars: raw.plays.text_only_min_chars ?? 100,
      maxAttempts: raw.plays.max_attempts,
      leaseSeconds: raw.plays.lease_minutes * 60,
      mediaRetrySeconds: raw.plays.media_retry_minutes * 60,
      maxImagesStored: raw.plays.max_images_stored,
      maxImagesLlm: raw.plays.max_images_llm,
      maxImageBytes: raw.plays.max_image_mb * 1024 * 1024,
      maxRequestBytes: raw.plays.max_request_mb * 1024 * 1024,
      redditUserAgent: raw.plays.reddit_user_agent,
      mediaDir: join(root, raw.storage.data_dir, 'media', 'plays'),
      llm: {
        provider: raw.plays.llm.provider,
        extractModel: raw.plays.llm.extract_model,
        interpretModel: raw.plays.llm.interpret_model,
        maxPlaysPerTick: raw.plays.llm.max_plays_per_tick,
        maxOutputTokens: raw.plays.llm.max_output_tokens,
        dailyBudgetUsd: raw.plays.llm.daily_budget_usd,
        prices: raw.plays.llm.prices ?? {},
      },
      herd: {
        lookbackHours: raw.plays.herd.lookback_hours,
        minAuthors: raw.plays.herd.min_authors,
      },
      heatStalenessSeconds: (raw.plays.evidence?.heat_staleness_hours ?? 6) * 3600,
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

/** The whitelist as a bare membership set — the plays validation pass's `isListedTicker` (product
 *  §4.1). Same file + parsing as `buildExtractor`; null when unconfigured/missing (cashtag-only
 *  mode), in which case every non-known-non-equity ticker validates as `unvalidated`. */
export function loadWhitelistSet(raw: RawConfig, root: string): Set<string> | null {
  const wlPath = raw.extract.whitelist_path ? join(root, raw.extract.whitelist_path) : null
  if (!wlPath || !existsSync(wlPath)) return null
  return loadWordset(readFileSync(wlPath, 'utf8'))
}

/** Port of `cli._arctic_source`. */
export function buildSource(raw: RawConfig): ArcticShiftSource {
  const ing = raw.ingest
  return new ArcticShiftSource(raw.sources.arctic_shift.base_url, ing.subreddit, {
    pageLimit: ing.page_limit,
    maxPages: ing.max_pages,
    userAgent: ing.user_agent,
    timeoutMs: ing.request_timeout * 1000,
    maxRetries: ing.max_retries,
    retryBackoffMs: ing.retry_backoff_ms,
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
