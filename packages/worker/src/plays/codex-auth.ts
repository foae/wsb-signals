/**
 * OpenAI Codex subscription auth (P2 — user decision 2026-08-19): the extraction provider can ride
 * the ChatGPT-subscription OAuth that the `pi` harness maintains, instead of a platform API key.
 * The token file is pi's `~/.pi/agent/auth.json`, mounted READ-ONLY into the worker:
 *
 *  - the file is re-read on every access-token request — pi refreshes it on its own use, and the
 *    freshest source wins;
 *  - when the file's token is (nearly) expired, we refresh IN MEMORY via the same OAuth client pi
 *    uses. We NEVER write the file — racing pi's own writer could corrupt its auth store. OpenAI's
 *    refresh grant returns a new refresh token, but the old one stays valid until used again by
 *    pi, whose copy is authoritative.
 */
import { readFile } from 'node:fs/promises'

import { fetch as undiciFetch } from 'undici'

import { log } from '../logger'

/** Same public OAuth client the Codex CLI / pi use. */
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
/** Refresh when the token has less life than this left. */
const EXPIRY_SLACK_MS = 5 * 60_000

interface StoredAuth {
  access: string
  refresh: string
  /** Epoch ms. */
  expires: number
  accountId: string
}

export interface CodexCredentials {
  accessToken: string
  accountId: string
}

async function readAuthFile(path: string): Promise<StoredAuth> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as { 'openai-codex'?: Partial<StoredAuth> }
  const a = parsed['openai-codex']
  if (!a?.access || !a.refresh || !a.accountId || typeof a.expires !== 'number') {
    throw new Error(`codex auth file ${path} has no usable openai-codex entry (run \`pi\` → /login on the host)`)
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
    // Prefer whichever token lives longer — pi may have refreshed the file since our last in-memory
    // refresh, or vice versa.
    if (this.memory && this.memory.expires > auth.expires) auth = this.memory
    if (auth.expires - now < EXPIRY_SLACK_MS) {
      auth = await this.refresh(auth, signal)
      this.memory = auth
    }
    return { accessToken: auth.access, accountId: auth.accountId }
  }

  private async refresh(auth: StoredAuth, signal?: AbortSignal): Promise<StoredAuth> {
    log.info('codex auth: access token stale — refreshing in memory (pi\'s file is never written)')
    const res = await undiciFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: auth.refresh,
        client_id: CLIENT_ID,
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
