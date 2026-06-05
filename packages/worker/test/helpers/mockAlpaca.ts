import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A throwaway HTTP server replaying an Alpaca CASSETTE (the same page-spec the Python oracle harness
 * drives through the frozen `AlpacaMarketData`). Dispatches by path: snapshot chunks are served in
 * order; the two screener endpoints have fixed responses. An `{error:"network"}` page resets the socket
 * so undici's `fetch` rejects (the never-kill-is-the-loop's-job path). Docker-free.
 */

export interface AlpacaPage {
  status?: number
  headers?: Record<string, string>
  json?: unknown
  body?: string
  error?: string // "network" → reset the connection
}

export interface AlpacaCassette {
  snapshots?: AlpacaPage[]
  most_actives?: AlpacaPage
  movers?: AlpacaPage
}

export interface MockAlpaca {
  baseUrl: string
  requests: Array<{ path: string; url: string; headers: IncomingHttpHeaders }>
  close: () => Promise<void>
}

export async function startMockAlpaca(cassette: AlpacaCassette): Promise<MockAlpaca> {
  let snapIdx = 0
  const requests: MockAlpaca['requests'] = []

  const server = createServer((req, res) => {
    const url = req.url ?? ''
    requests.push({ path: url.split('?')[0] ?? '', url, headers: req.headers })

    let page: AlpacaPage | undefined
    if (url.includes('/snapshots')) page = cassette.snapshots?.[snapIdx++]
    else if (url.includes('/most-actives')) page = cassette.most_actives
    else if (url.includes('/movers')) page = cassette.movers

    if (!page) {
      res.statusCode = 598 // ran off the cassette → a clear non-200
      res.end('no such cassette page')
      return
    }
    if (page.error === 'network') {
      req.socket?.destroy()
      return
    }
    for (const [k, v] of Object.entries(page.headers ?? {})) res.setHeader(k, v)
    res.statusCode = page.status ?? 200
    if (page.json === undefined && page.body !== undefined) {
      res.end(page.body) // non-200 / raw-body responses
      return
    }
    res.end(JSON.stringify(page.json ?? {}))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.()
        server.close((e) => (e ? reject(e) : resolve()))
      }),
  }
}
