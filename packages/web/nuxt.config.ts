// Nuxt 4 SSR config (skeleton — slice 0). The leaderboard/history pages + Nitro read routes land in
// slice 8 (v2-plan.md §4): SSR, route-cached to the ~5-min cadence, reading complete windows only from
// a read-only Postgres role. For now this proves Nuxt 4 + Nuxt UI v4 install, prepare, and build.
export default defineNuxtConfig({
  compatibilityDate: '2026-06-01',
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  // The web is read-only; the writer (worker) owns DDL/migrations. DATABASE_URL is a read-only role
  // wired in slice 8 — declared here so the shape is visible, populated from env at runtime.
  runtimeConfig: {
    databaseUrl: '', // NUXT_DATABASE_URL (read-only role)
  },
})
