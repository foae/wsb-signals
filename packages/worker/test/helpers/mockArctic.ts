import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A throwaway HTTP server that replays an Arctic-Shift CASSETTE (the same page-spec the Python oracle
 * harness drives — porting-spec §9 "mock server, not just VCR happy-path"). Per kind it serves pages in
 * order; an `{error:"network"}` page resets the TCP socket so undici's `fetch` rejects exactly as a real
 * connection drop would. Docker-free — runs under the default `pnpm test`.
 */

export interface CassettePage {
  status?: number
  headers?: Record<string, string>
  data?: unknown[]
  non_json?: boolean
  body?: string
  error?: string // "network" → reset the connection mid-request
}

export interface Cassette {
  posts: CassettePage[]
  comments: CassettePage[]
}

export interface MockArctic {
  baseUrl: string
  /** Every request seen, in order — lets a test assert pagination params (before=now+5, after=cutoff). */
  requests: Array<{ kind: 'posts' | 'comments'; url: string }>
  close: () => Promise<void>
}

export async function startMockArctic(cassette: Cassette): Promise<MockArctic> {
  const idx: Record<'posts' | 'comments', number> = { posts: 0, comments: 0 }
  const requests: MockArctic['requests'] = []

  const server = createServer((req, res) => {
    const url = req.url ?? ''
    const kind: 'posts' | 'comments' = url.includes('/posts/') ? 'posts' : 'comments'
    requests.push({ kind, url })
    const page = cassette[kind][idx[kind]++]
    if (!page) {
      res.statusCode = 598 // ran off the end of the cassette → a clear non-200 (surfaces an over-fetch bug)
      res.end('no such cassette page')
      return
    }
    if (page.error === 'network') {
      req.socket?.destroy() // ECONNRESET → fetch rejects (the network-error branch)
      return
    }
    for (const [k, v] of Object.entries(page.headers ?? {})) res.setHeader(k, v)
    const status = page.status ?? 200
    res.statusCode = status
    if (page.non_json) {
      res.end(page.body ?? 'definitely-not-json{')
      return
    }
    if (status !== 200) {
      res.end(page.body ?? '')
      return
    }
    res.end(JSON.stringify({ data: page.data ?? [] }))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.() // undici keep-alive would otherwise hold the socket open
        server.close((e) => (e ? reject(e) : resolve()))
      }),
  }
}
