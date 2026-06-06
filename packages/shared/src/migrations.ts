import { fileURLToPath } from 'node:url'

/**
 * Absolute path to the drizzle-kit migrations folder (`packages/shared/drizzle`). The WORKER runs these
 * on boot via drizzle-orm's migrator; the web never migrates (v2-porting-spec.md §6). Resolved from this
 * file's location so it works whether the worker runs via tsx or compiled. Separate entry point so the
 * web bundle never pulls in `node:url`.
 */
export const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))
