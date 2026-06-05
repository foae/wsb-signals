import { defineConfig } from 'drizzle-kit'

// The WORKER owns DDL/migrations; the web never migrates (v2-porting-spec.md §6).
export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  strict: true,
  verbose: true,
})
