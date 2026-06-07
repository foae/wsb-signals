import { defineConfig } from 'vitest/config'

// Integration tests — testcontainers Postgres (needs Docker). Run via `pnpm -C packages/web test:it`.
export default defineConfig({
  test: {
    include: ['test/**/*.it.test.ts'],
    environment: 'node',
    testTimeout: 120_000, // image pull + container start on a cold cache
    hookTimeout: 120_000,
  },
})
