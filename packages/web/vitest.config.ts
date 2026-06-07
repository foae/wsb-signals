import { defineConfig } from 'vitest/config'

// Unit tests — Docker-free. The web's only tests today are the testcontainers integration test
// (board.it.test.ts), which lives in vitest.integration.config.ts so the default `pnpm test` stays
// fast and Docker-free (mirrors the worker). passWithNoTests keeps `pnpm -r test` green here.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.it.test.ts', 'node_modules/**', '.nuxt/**', '.output/**'],
    environment: 'node',
    passWithNoTests: true,
  },
})
