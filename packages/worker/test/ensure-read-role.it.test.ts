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

function roUri(): string {
  return `postgres://${RO_USER}:${RO_PW}@${pg.container.getHost()}:${pg.container.getPort()}/${pg.container.getDatabase()}`
}

// Clean up the role between tests so each run starts from a known state (TRUNCATE doesn't drop roles).
afterEach(async () => {
  await pg.pool.query(`DROP TABLE IF EXISTS future_t`)
  await pg.pool.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${RO_USER}') THEN
        EXECUTE 'REASSIGN OWNED BY ${RO_USER} TO ' || current_user;
        EXECUTE 'DROP OWNED BY ${RO_USER}';
        DROP ROLE ${RO_USER};
      END IF;
    END $$;`)
})

describe('ensureReadRole', () => {
  it('is a no-op when credentials are unset', async () => {
    await expect(ensureReadRole(pg.pool, undefined, undefined)).resolves.toBeUndefined()
    const { rows } = await pg.pool.query(`SELECT 1 FROM pg_roles WHERE rolname = '${RO_USER}'`)
    expect(rows.length).toBe(0)
  })

  it('creates a role that can SELECT existing tables but cannot write', async () => {
    await ensureReadRole(pg.pool, RO_USER, RO_PW)
    const ro = new Pool({ connectionString: roUri() })
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
    const ro = new Pool({ connectionString: roUri() })
    try {
      await expect(ro.query('SELECT * FROM future_t')).resolves.toBeDefined()
    } finally {
      await ro.end()
    }
  })

  it('is idempotent and updates the password on re-run', async () => {
    await ensureReadRole(pg.pool, RO_USER, RO_PW)
    await expect(ensureReadRole(pg.pool, RO_USER, 'rotated_pw')).resolves.toBeUndefined()
    const ro = new Pool({ connectionString: `postgres://${RO_USER}:rotated_pw@${pg.container.getHost()}:${pg.container.getPort()}/${pg.container.getDatabase()}` })
    try {
      await expect(ro.query('SELECT 1')).resolves.toBeDefined()
    } finally {
      await ro.end()
    }
  })

  it('rejects an unsafe role identifier rather than building injectable SQL', async () => {
    await expect(ensureReadRole(pg.pool, 'bad name; DROP', RO_PW)).rejects.toThrow(/unsafe SQL identifier/)
  })
})
