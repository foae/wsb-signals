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
    // Plays media root (the shared worker↔web volume) — NUXT_MEDIA_DIR. Empty ⇒ /api/media/** 404s.
    mediaDir: '',
    // Display tunables. Defaults mirror config.toml; override via NUXT_MAX_STALENESS_SECONDS /
    // NUXT_WINDOW_SECONDS if the worker's config.toml changes (shared-constants coupling, v2-plan §7).
    maxStalenessSeconds: MAX_STALENESS_SECONDS,
    windowSeconds: WINDOW_SECONDS,
  },
  // The board is near-live (~5-min cadence) and exact within each cached response. A short blocking
  // cache avoids DB churn without SWR's stale-first response after the underlying data changes; the
  // snapshot-isolation read (server/utils/board.ts) keeps each response internally consistent.
  // Thrown errors aren't cached.
  routeRules: {
    '/api/board': { cache: { maxAge: 30 } },
    // Old plays index URL — exact path only (no /** glob), so /plays/:id detail routes are untouched.
    '/plays': { redirect: '/' },
  },
})
