/**
 * `codex-login` — establish the ChatGPT-subscription OAuth for the `openai-codex` provider with no
 * external harness (the `pi` harness that used to own the auth file is retired, 2026-08-20).
 *
 * Runs the same authorization-code + PKCE flow as the Codex CLI (same public client, same
 * localhost:1455 callback), then writes the auth file `CodexAuth` consumes. One interactive run
 * establishes access + REFRESH tokens; from then on the worker/eval refresh and persist on their
 * own (codex-auth.ts).
 *
 * Usage:
 *   pnpm -C packages/worker codex-login [--out <path>]     # default: $CODEX_AUTH_FILE or ~/.pi/agent/auth.json
 *
 * The callback lands on localhost:1455, so on a headless box tunnel it first:
 *   ssh -L 1455:localhost:1455 <box>   — then open the printed URL in your local browser.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { fetch as undiciFetch } from 'undici'

import { log } from '../logger'
import { CODEX_CLIENT_ID, CODEX_TOKEN_URL, writeAuthFile, type StoredAuth } from './codex-auth'

const AUTH_URL = 'https://auth.openai.com/oauth/authorize'
const PORT = 1455
const REDIRECT_URI = `http://localhost:${PORT}/auth/callback`
/** Give the human ten minutes to click through the browser flow before giving up. */
const LOGIN_TIMEOUT_MS = 10 * 60_000

const b64url = (buf: Buffer): string => buf.toString('base64url')

/** `offline_access` is what yields the refresh token — the whole point of this CLI. */
const SCOPE = 'openid profile email offline_access'

function accountIdFromAccessToken(access: string): string {
  const payload = access.split('.')[1]
  if (!payload) throw new Error('access token is not a JWT')
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
    'https://api.openai.com/auth'?: { chatgpt_account_id?: string }
  }
  const id = claims['https://api.openai.com/auth']?.chatgpt_account_id
  if (!id) throw new Error('access token carries no chatgpt_account_id claim')
  return id
}

async function exchangeCode(code: string, verifier: string): Promise<StoredAuth> {
  const res = await undiciFetch(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CODEX_CLIENT_ID,
      code_verifier: verifier,
    }).toString(),
  })
  if (res.status !== 200) {
    throw new Error(`token exchange failed: status ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`)
  }
  const json = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number }
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
    throw new Error('token exchange returned no access/refresh token — cannot establish a self-refreshing auth')
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId: accountIdFromAccessToken(json.access_token),
  }
}

async function main(): Promise<void> {
  const outFlag = process.argv.indexOf('--out')
  const outPath = outFlag > -1
    ? process.argv[outFlag + 1]!
    : process.env.CODEX_AUTH_FILE || join(homedir(), '.pi', 'agent', 'auth.json')

  const verifier = b64url(randomBytes(64))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(32))

  const url = `${AUTH_URL}?${new URLSearchParams({
    response_type: 'code',
    client_id: CODEX_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    // The backend gates this client on its known originator (same value the Codex CLI sends).
    originator: 'codex_cli_rs',
  }).toString()}`

  const done = new Promise<StoredAuth>((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const u = new URL(req.url ?? '/', REDIRECT_URI)
      if (u.pathname !== '/auth/callback') { res.writeHead(404).end(); return }
      const fail = (msg: string): void => {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end(`codex-login: ${msg}`)
        reject(new Error(msg))
        server.close()
      }
      if (u.searchParams.get('state') !== state) return fail('state mismatch — retry the login')
      const err = u.searchParams.get('error')
      if (err) return fail(`provider returned error: ${err} ${u.searchParams.get('error_description') ?? ''}`)
      const code = u.searchParams.get('code')
      if (!code) return fail('callback carried no code')
      exchangeCode(code, verifier).then((auth) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
          .end('codex-login: success — tokens stored, you can close this tab.')
        resolve(auth)
        server.close()
      }).catch((e: unknown) => fail(String(e)))
    })
    server.on('error', (e) => reject(new Error(`cannot listen on :${PORT} (${String(e)}) — is another login running?`)))
    server.listen(PORT, '127.0.0.1')
    setTimeout(() => { reject(new Error(`no callback within ${LOGIN_TIMEOUT_MS / 60_000} min — giving up`)); server.close() },
      LOGIN_TIMEOUT_MS).unref()
  })

  process.stderr.write(`\nOpen this URL in a browser to authorize (headless box: first \`ssh -L ${PORT}:localhost:${PORT} <box>\`):\n\n${url}\n\n`)

  const auth = await done
  await mkdir(dirname(outPath), { recursive: true })
  await writeAuthFile(outPath, auth)
  log.info({ outPath, accountId: auth.accountId, expires: new Date(auth.expires).toISOString() },
    'codex-login: auth established (access + refresh) — the worker/eval will self-refresh from here')
}

main().catch((e: unknown) => {
  log.error({ err: String(e) }, 'codex-login failed')
  process.exit(1)
})
