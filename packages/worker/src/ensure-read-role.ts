/**
 * Idempotently provision the WEB's read-only Postgres role + grants, on worker boot (right after
 * migrations). Why the worker and not Docker `initdb`:
 *
 *  - Docker's `/docker-entrypoint-initdb.d` scripts run ONLY when the data dir is empty. The slice-10
 *    headless deploy already created the `wsb-v2-pg` volume, so an initdb script would never fire there.
 *  - The worker is the only component that holds the privileged (writer/superuser) connection AND already
 *    runs a boot-time DDL step (`migrateToLatest`). Running here every boot is self-healing for fresh AND
 *    existing clusters.
 *  - `ALTER DEFAULT PRIVILEGES FOR ROLE <writer>` MUST name the role that CREATES the tables — Postgres
 *    scopes default privileges to the object-creating role, not inherited memberships. That role is the
 *    migration role = `current_user` on this connection. Naming the wrong role silently leaves future
 *    worker-created tables unreadable by the web (a review-gate HIGH finding).
 *
 * No-op unless both WEB_RO_USER and WEB_RO_PASSWORD are set, so the worker-only headless deploy is
 * unaffected. Every statement is idempotent (guarded role create; GRANT/ALTER DEFAULT PRIVILEGES are
 * naturally idempotent), so re-running each boot is safe. (v2-plan §6.)
 */
import type { Pool } from 'pg'

import { log } from './logger'

const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Double-quote a SQL identifier, rejecting anything that isn't a plain identifier (DDL can't be parameterized). */
function quoteIdent(name: string): string {
  if (!SAFE_IDENT.test(name)) {
    throw new Error(`unsafe SQL identifier ${JSON.stringify(name)} — expected /^[A-Za-z_][A-Za-z0-9_]*$/`)
  }
  return `"${name}"`
}

/** Single-quote a SQL string literal (only the password reaches this — DDL can't bind it). */
function quoteLiteral(val: string): string {
  return `'${val.replace(/'/g, "''")}'`
}

export async function ensureReadRole(
  pool: Pool,
  roUser: string | undefined,
  roPassword: string | undefined,
): Promise<void> {
  if (!roUser || !roPassword) {
    log.info('read-only role not provisioned (WEB_RO_USER / WEB_RO_PASSWORD unset) — skipping')
    return
  }
  const ro = quoteIdent(roUser)
  const pw = quoteLiteral(roPassword)
  const roLit = quoteLiteral(roUser)

  const client = await pool.connect()
  try {
    const { rows } = await client.query<{ writer: string, db: string }>(
      'SELECT current_user AS writer, current_database() AS db',
    )
    const writer = quoteIdent(rows[0]!.writer)
    const db = quoteIdent(rows[0]!.db)

    // Create-or-reset the login role (password kept in sync with env so a rotation lands on next boot).
    await client.query(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${roLit}) THEN
           CREATE ROLE ${ro} LOGIN PASSWORD ${pw};
         ELSE
           ALTER ROLE ${ro} WITH LOGIN PASSWORD ${pw};
         END IF;
       END $$;`,
    )
    await client.query(`GRANT CONNECT ON DATABASE ${db} TO ${ro};`)
    await client.query(`GRANT USAGE ON SCHEMA public TO ${ro};`)
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ro};`)
    // Future tables the worker migrates get SELECT automatically — scoped to the CREATING role (writer).
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${writer} IN SCHEMA public GRANT SELECT ON TABLES TO ${ro};`,
    )
    log.info({ role: roUser }, 'read-only role ensured (SELECT on public + default privileges for future tables)')
  } finally {
    client.release()
  }
}
