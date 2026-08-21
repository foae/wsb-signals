/**
 * Cross-cutting tunables the WEB needs that otherwise live only in the worker's `config.toml` /
 * `config.ts`. These are canonical DEFAULTS mirroring `config.toml` ([ingest] `window_seconds`,
 * [heartbeat] `max_staleness_seconds`). The web overrides them via `NUXT_*` env (see the web's
 * `nuxt.config.ts` runtimeConfig).
 *
 * COUPLING (v2-plan §7): the worker reads the live values from `config.toml`; these are a separate
 * copy. If an operator changes `config.toml`, they MUST set the matching `NUXT_*` env or the web's
 * window header / staleness banner will silently drift. Documented in `deploy/v2/README.md`.
 */

/** 1h primary window (config.toml [ingest] window_seconds). Used for the board's window-end header. */
export const WINDOW_SECONDS = 3600

/** Freshness bound (config.toml [heartbeat] max_staleness_seconds): older `newest_utc` ⇒ stale banner. */
export const MAX_STALENESS_SECONDS = 1800

/** Persisted with each heat snapshot so historical scores never silently mix scoring contracts. */
export const HEAT_SCORING_VERSION = 'heat-2026-08-21'

/** Removed-source repair contract; observed-at watermarks make repeated runs incremental. */
export const HEAT_REPAIR_VERSION = 'removed-content-v2'

/** Conservative market-context floor; every screener row must clear both thresholds. */
export const MIN_MARKET_CONTEXT_PRICE = 5
export const MIN_MARKET_CONTEXT_VOLUME = 1_000_000
