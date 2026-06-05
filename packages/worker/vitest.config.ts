import { defineConfig } from 'vitest/config'

// Unit tests — pure logic, no Docker. The parity slices (extract/classify, aggregate) run here and
// diff against the committed golden fixtures in fixtures/. Integration tests (testcontainers PG) live
// in vitest.integration.config.ts so the default `pnpm test` stays fast and Docker-free.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['test/**/*.it.test.ts'],
    environment: 'node',
  },
})
