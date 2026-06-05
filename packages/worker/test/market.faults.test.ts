import { describe, expect, it } from 'vitest'

import { AlpacaMarketData } from '../src/market'
import { startMockAlpaca } from './helpers/mockAlpaca'

// Slice-5 best-effort / I/O behavior (porting-spec §5 + §7): auth + chunking + the deliberate split of
// responsibility — the CLIENT swallows non-200s but PROPAGATES a network error; never-kill is the loop's
// job (slice 6). These assert that contract directly rather than against the oracle.

describe('market client fault / best-effort behavior', () => {
  it('sends APCA auth headers + feed/symbols params on a snapshot request', async () => {
    const mock = await startMockAlpaca({ snapshots: [{ status: 200, json: {} }] })
    try {
      const c = new AlpacaMarketData('mykey', 'mysecret', { dataUrl: mock.baseUrl, feed: 'iex' })
      await c.snapshots(['AAA', 'BBB'], 123)
      const req = mock.requests[0]!
      expect(req.headers['apca-api-key-id']).toBe('mykey')
      expect(req.headers['apca-api-secret-key']).toBe('mysecret')
      expect(req.url).toContain('feed=iex')
      expect(req.url).toContain('symbols=AAA%2CBBB') // comma-joined, URL-encoded
    } finally {
      await mock.close()
    }
  })

  it('makes no request for an empty ticker list (Python early return)', async () => {
    const mock = await startMockAlpaca({ snapshots: [] })
    try {
      const c = new AlpacaMarketData('k', 's', { dataUrl: mock.baseUrl })
      const snaps = await c.snapshots([], 1)
      expect(snaps.size).toBe(0)
      expect(mock.requests.length).toBe(0)
    } finally {
      await mock.close()
    }
  })

  it('chunks > 100 symbols into ceil(n/100) requests', async () => {
    const tickers = Array.from({ length: 250 }, (_, i) => `S${i}`)
    const mock = await startMockAlpaca({
      snapshots: [{ status: 200, json: {} }, { status: 200, json: {} }, { status: 200, json: {} }],
    })
    try {
      const c = new AlpacaMarketData('k', 's', { dataUrl: mock.baseUrl })
      await c.snapshots(tickers, 1)
      expect(mock.requests.filter((r) => r.path.includes('/snapshots')).length).toBe(3) // ceil(250/100)
    } finally {
      await mock.close()
    }
  })

  it('PROPAGATES a network error — never-kill is the loop’s responsibility, not the client', async () => {
    const mock = await startMockAlpaca({ snapshots: [{ error: 'network' }] })
    try {
      const c = new AlpacaMarketData('k', 's', { dataUrl: mock.baseUrl })
      await expect(c.snapshots(['AAA'], 1)).rejects.toBeTruthy()
    } finally {
      await mock.close()
    }
  })

  it('screeners calls BOTH endpoints independently even when the first fails (best-effort)', async () => {
    const mock = await startMockAlpaca({
      most_actives: { status: 500, body: 'boom' },
      movers: { status: 500, body: 'boom' },
    })
    try {
      const c = new AlpacaMarketData('k', 's', { dataUrl: mock.baseUrl })
      const movers = await c.screeners(25, 1)
      expect(movers).toEqual([]) // both failed → empty, but no throw
      expect(mock.requests.map((r) => r.path)).toEqual([
        '/v1beta1/screener/stocks/most-actives',
        '/v1beta1/screener/stocks/movers',
      ])
    } finally {
      await mock.close()
    }
  })
})
