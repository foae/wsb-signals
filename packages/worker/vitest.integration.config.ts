import { defineConfig } from 'vitest/config'

// Integration tests — require Docker (testcontainers spins a throwaway Postgres). Run via
// `pnpm test:it`. Kept out of the default unit run so CI/dev without Docker stays green.
// Postgres image pulls + container boot are slow, so the timeout is generous.
export default defineConfig({
  test: {
    include: ['test/**/*.it.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
