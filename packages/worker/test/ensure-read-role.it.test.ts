/**
 * Integration test for the worker's read-only role provisioning (slice 8) on real Postgres. This pins the
 * review-gate HIGH finding: the role must be able to SELECT current AND future (worker-migrated) tables,
 * and must NOT be able to write. `ALTER DEFAULT PRIVILEGES FOR ROLE <writer>` is verified by creating a
 * table AFTER provisioning and checking the role can read it.
 */
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { ensureReadRole } from '../src/ensure-read-role'
import { startPg, type PgHarness } from './helpers/pg'

let pg: PgHarness
beforeAll(async () => { pg = await startPg() }, 120_000)
afterAll(async () => { await pg?.stop() })
beforeEach(async () => { await pg.reset() })

const RO_USER = 'wsb_web_ro'
const RO_PW = 'ro_secret_pw'
const TEST_ROLES = ['wsb_web_ro', 'wsb-web-ro'] // every role any test may create — all dropped in afterEach

function qIdent(n: string): string {
  return `"${n.replace(/"/g, '""')}"`
}

/** A read-only Pool via a config object (avoids URI-encoding passwords with special chars). */
function roPool(user: string, password: string): Pool {
  return new Pool({
    host: pg.container.getHost(),
    port: pg.container.getPort(),
    database: pg.container.getDatabase(),
    user,
    password,
  })
}

// Clean up roles between tests so each run starts from a known state (TRUNCATE doesn't drop roles).
afterEach(async () => {
  await pg.pool.query('DROP TABLE IF EXISTS future_t')
  for (const r of TEST_ROLES) {
    const exists = await pg.pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [r])
    if ((exists.rowCount ?? 0) > 0) {
      const q = qIdent(r)
      await pg.pool.query(`REASSIGN OWNED BY ${q} TO CURRENT_USER`)
      await pg.pool.query(`DROP OWNED BY ${q}`)
      await pg.pool.query(`DROP ROLE ${q}`)
    }
  }
})

describe('ensureReadRole', () => {
  it('is a no-op when credentials are unset', async () => {
    await expect(ensureReadRole(pg.pool, undefined, undefined)).resolves.toBeUndefined()
    const { rows } = await pg.pool.query(`SELECT 1 FROM pg_roles WHERE rolname = '${RO_USER}'`)
    expect(rows.length).toBe(0)
  })

  it('creates a role that can SELECT existing tables but cannot write', async () => {
    await ensureReadRole(pg.pool, RO_USER, RO_PW)
    const ro = roPool(RO_USER, RO_PW)
    try {
      // can read a migrated table
      await expect(ro.query('SELECT * FROM cycle_runs')).resolves.toBeDefined()
      // cannot write
      await expect(ro.query(`INSERT INTO cycle_runs (window_start, status) VALUES (1, 'complete')`))
        .rejects.toThrow(/permission denied/i)
    } finally {
      await ro.end()
    }
  })

  it('grants SELECT on FUTURE tables via ALTER DEFAULT PRIVILEGES (the existing-volume fix)', async () => {
    await ensureReadRole(pg.pool, RO_USER, RO_PW)
    // A table created by the writer AFTER provisioning — exactly the "worker migrates new tables later" case.
    await pg.pool.query('CREATE TABLE future_t (id int)')
    const ro = roPool(RO_USER, RO_PW)
    try {
      await expect(ro.query('SELECT * FROM future_t')).resolves.toBeDefined()
    } finally {
      await ro.end()
    }
  })

  it('is idempotent and updates the password on re-run', async () => {
    await ensureReadRole(pg.pool, RO_USER, RO_PW)
    await expect(ensureReadRole(pg.pool, RO_USER, 'rotated_pw')).resolves.toBeUndefined()
    const ro = roPool(RO_USER, 'rotated_pw')
    try {
      await expect(ro.query('SELECT 1')).resolves.toBeDefined()
    } finally {
      await ro.end()
    }
  })

  it('supports a hyphenated role name via standard identifier quoting (no whitelist crash)', async () => {
    // A cloud-style role/db name with a hyphen must NOT crash provisioning (review-gate HIGH).
    await expect(ensureReadRole(pg.pool, 'wsb-web-ro', RO_PW)).resolves.toBeUndefined()
    const ro = roPool('wsb-web-ro', RO_PW)
    try {
      await expect(ro.query('SELECT * FROM cycle_runs')).resolves.toBeDefined()
    } finally {
      await ro.end()
    }
  })

  it('handles a password containing $$ and a quote without breaking provisioning (no dollar-quoted body)', async () => {
    // A `$$` in the password would terminate a `DO $$ … $$` block early — the provisioner must not use one.
    const weird = 'p$$a\'b"c'
    await expect(ensureReadRole(pg.pool, RO_USER, weird)).resolves.toBeUndefined()
    const ro = roPool(RO_USER, weird)
    try {
      await expect(ro.query('SELECT 1')).resolves.toBeDefined()
    } finally {
      await ro.end()
    }
  })
})
