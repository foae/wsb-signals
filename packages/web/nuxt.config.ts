import { MAX_STALENESS_SECONDS, WINDOW_SECONDS } from '@wsb/shared'

// Nuxt 4 SSR config (slice 8). Read-only board: an SSR page + a Nitro read route over a READ-ONLY
// Postgres role. The worker owns DDL/migrations; the web never writes (v2-plan §1, porting-spec §6).
export default defineNuxtConfig({
  compatibilityDate: '2026-06-01',
  modules: ['@nuxt/ui', '@nuxt/eslint', '@nuxtjs/html-validator'],
  css: ['~/assets/css/main.css'],
  runtimeConfig: {
    // read-only Postgres role — NUXT_DATABASE_URL. Empty in source; populated from env at runtime.
    databaseUrl: '',
    // Display tunables. Defaults mirror config.toml; override via NUXT_MAX_STALENESS_SECONDS /
    // NUXT_WINDOW_SECONDS if the worker's config.toml changes (shared-constants coupling, v2-plan §7).
    maxStalenessSeconds: MAX_STALENESS_SECONDS,
    windowSeconds: WINDOW_SECONDS,
  },
  // The board is near-live (~5-min cadence) and immutable per window. Cache the read route briefly with
  // stale-while-revalidate so reloads are cheap without pinning a dead cycle; the snapshot-isolation read
  // (server/utils/board.ts) keeps each cached response internally consistent. Thrown errors aren't cached.
  routeRules: {
    '/api/board': { cache: { maxAge: 60, swr: true } },
  },
})
