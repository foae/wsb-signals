/**
 * OpenAI Codex subscription auth (P2 — user decision 2026-08-19): the extraction provider rides
 * the ChatGPT-subscription OAuth instead of a platform API key. The token file
 * (`~/.pi/agent/auth.json` on the host — the path is historical, from the retired `pi` harness)
 * is established by the `codex-login` CLI and OWNED BY THIS PROJECT since 2026-08-20 (pi is gone):
 *
 *  - the file is re-read on every access-token request — a host-side re-login or refresh lands
 *    without a worker restart, and the freshest source wins;
 *  - when the file's token is (nearly) expired, we refresh via the same public OAuth client the
 *    Codex CLI uses, and PERSIST the result back best-effort: host-side runs (eval, CLIs) keep the
 *    file fresh; inside the worker container the mount is read-only, so persistence fails cleanly
 *    and the refreshed token carries the process in memory (each restart re-refreshes from the
 *    on-disk refresh token).
 */
import { randomBytes } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'

import { fetch as undiciFetch } from 'undici'

import { log } from '../logger'

/** Same public OAuth client the Codex CLI uses (also shared by `codex-login`). */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'
/** Refresh when the token has less life than this left. */
const EXPIRY_SLACK_MS = 5 * 60_000

export interface StoredAuth {
  access: string
  refresh: string
  /** Epoch ms. */
  expires: number
  accountId: string
}

/** Atomically write `auth` under the `openai-codex` key, preserving any other keys the file holds.
 *  Shared by `codex-login` (initial grant) and the in-process refresh (best-effort persist). */
export async function writeAuthFile(path: string, auth: StoredAuth): Promise<void> {
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch { /* absent or unparseable — start fresh */ }
  // pid alone can collide across overlapping in-process calls (review 2026-08-20); and on the
  // worker's read-only FILE mount the tmp write succeeds against the writable dir while the rename
  // onto the mount point fails — clean the orphan up instead of littering one per refresh.
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    await writeFile(tmp, `${JSON.stringify({ ...existing, 'openai-codex': auth }, null, 1)}\n`, { mode: 0o600 })
    await rename(tmp, path)
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }
}

export interface CodexCredentials {
  accessToken: string
  accountId: string
}

async function readAuthFile(path: string): Promise<StoredAuth> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as { 'openai-codex'?: Partial<StoredAuth> }
  const a = parsed['openai-codex']
  if (!a?.access || !a.refresh || !a.accountId || typeof a.expires !== 'number') {
    throw new Error(`codex auth file ${path} has no usable openai-codex entry (run \`pnpm -C packages/worker codex-login\` on the host)`)
  }
  return a as StoredAuth
}

/** Loads credentials, refreshing in memory when the on-disk token is stale. One instance per worker. */
export class CodexAuth {
  private memory: StoredAuth | null = null

  constructor(private readonly filePath: string) {}

  async credentials(signal?: AbortSignal): Promise<CodexCredentials> {
    const now = Date.now()
    let auth = await readAuthFile(this.filePath)
    // Prefer whichever token lives longer — a host-side re-login/refresh may have updated the file
    // since our last in-memory refresh, or vice versa.
    const fromMemory = this.memory != null && this.memory.expires > auth.expires
    if (fromMemory) auth = this.memory!
    if (auth.expires - now < EXPIRY_SLACK_MS) {
      try {
        auth = await this.refresh(auth, signal)
      } catch (e) {
        // A dead in-memory refresh token must not pin the process (review 2026-08-20): drop it so
        // the next call falls back to the file copy — which a host-side re-login may have renewed.
        if (fromMemory) this.memory = null
        throw e
      }
      this.memory = auth
      // Best-effort persist: succeeds on host-side runs; the worker container mounts the file
      // read-only, where the in-memory copy carries the process and a restart re-refreshes.
      try {
        await writeAuthFile(this.filePath, auth)
        log.info('codex auth: refreshed token persisted')
      } catch (e) {
        log.info({ err: String(e).slice(0, 120) }, 'codex auth: refreshed token NOT persisted (read-only mount?) — carrying it in memory')
      }
    }
    return { accessToken: auth.access, accountId: auth.accountId }
  }

  private async refresh(auth: StoredAuth, signal?: AbortSignal): Promise<StoredAuth> {
    log.info('codex auth: access token stale — refreshing')
    const res = await undiciFetch(CODEX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: auth.refresh,
        client_id: CODEX_CLIENT_ID,
      }).toString(),
      signal,
    })
    if (res.status !== 200) {
      const body = (await res.text().catch(() => '')).slice(0, 200)
      throw new Error(`codex auth refresh failed: status ${res.status} ${body}`)
    }
    const json = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number }
    if (!json.access_token || typeof json.expires_in !== 'number') {
      throw new Error('codex auth refresh returned no access_token')
    }
    return {
      access: json.access_token,
      refresh: json.refresh_token ?? auth.refresh,
      expires: Date.now() + json.expires_in * 1000,
      accountId: auth.accountId,
    }
  }
}
