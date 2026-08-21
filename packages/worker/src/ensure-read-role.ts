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

/**
 * Standard SQL identifier quoting — double the interior double-quotes (SQL-92). Injection-safe for ANY
 * identifier, and unlike a strict whitelist it supports cloud DB/role names with hyphens or dots
 * (`wsb-signals`, `postgres-admin`) instead of crashing the worker on boot.
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** Single-quote a SQL string literal — double the interior single-quotes. Used ONLY in plain statements
 *  (never inside a dollar-quoted body), so a value containing `$$` is just literal characters. */
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

  const client = await pool.connect()
  try {
    const { rows } = await client.query<{ writer: string, db: string }>(
      'SELECT current_user AS writer, current_database() AS db',
    )
    const writer = quoteIdent(rows[0]!.writer)
    const db = quoteIdent(rows[0]!.db)

    // Create-or-reset the login role (password kept in sync with env so a rotation lands on next boot).
    // The existence check uses a BOUND parameter; CREATE/ALTER run as plain statements so the password
    // literal is never inside a dollar-quoted `DO $$ … $$` body (a `$$` in the password would otherwise
    // terminate that body early — a provisioning-break / injection vector).
    const existing = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [roUser])
    if ((existing.rowCount ?? 0) === 0) {
      await client.query(`CREATE ROLE ${ro} LOGIN PASSWORD ${pw}`)
    } else {
      await client.query(`ALTER ROLE ${ro} WITH LOGIN PASSWORD ${pw}`)
    }
    // Agent-facing longitudinal reads share this role with the web. Bound accidental fan-out so a
    // broad LAN query cannot starve the single writer's five-minute publish cycle (invariant P1).
    await client.query(`ALTER ROLE ${ro} SET statement_timeout = '15s'`)
    await client.query(`ALTER ROLE ${ro} SET default_transaction_read_only = on`)
    await client.query(`GRANT CONNECT ON DATABASE ${db} TO ${ro}`)
    await client.query(`GRANT USAGE ON SCHEMA public TO ${ro}`)
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ro}`)
    // Future tables the worker migrates get SELECT automatically — scoped to the CREATING role (writer).
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${writer} IN SCHEMA public GRANT SELECT ON TABLES TO ${ro}`,
    )
    log.info({ role: roUser }, 'read-only role ensured (SELECT on public + default privileges for future tables)')
  } finally {
    client.release()
  }
}
