import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildWhitelist, fetchAlpacaAssets } from '../src/assets'

// ---------------------------------------------------------------------------
// Minimal mock server for the Alpaca /assets endpoint
// ---------------------------------------------------------------------------

interface MockAssetsServer {
  baseUrl: string
  close: () => Promise<void>
}

async function startMockAssets(
  response: { status: number; body: unknown } | { status: number; body: string; raw: true },
): Promise<MockAssetsServer> {
  const server = createServer((_req, res) => {
    if ('raw' in response) {
      res.statusCode = response.status
      res.end(response.body as string)
      return
    }
    res.statusCode = response.status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(response.body))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${port}/v2`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.()
        server.close((e) => (e ? reject(e) : resolve()))
      }),
  }
}

// ---------------------------------------------------------------------------
// Sample asset rows exercising all filter paths
// ---------------------------------------------------------------------------

const SAMPLE_ASSETS = [
  // kept: tradable non-OTC
  { symbol: 'AAPL', name: 'Apple Inc.', tradable: true, exchange: 'NASDAQ' },
  // dropped: not tradable
  { symbol: 'DEAD', name: 'Dead Corp', tradable: false, exchange: 'NYSE' },
  // dropped: OTC (when includeOtc=false)
  { symbol: 'PNKQ', name: 'Pink Sheet Co', tradable: true, exchange: 'OTC' },
  // kept: tradable non-OTC
  { symbol: 'MSFT', name: 'Microsoft Corp', tradable: true, exchange: 'NASDAQ' },
  // duplicate symbol — first occurrence wins (AAPL already seen; second entry is skipped)
  { symbol: 'AAPL', name: 'Apple Duplicate', tradable: true, exchange: 'NYSE' },
  // dropped: empty symbol after trim
  { symbol: '  ', name: 'Whitespace Sym', tradable: true, exchange: 'NYSE' },
  // dropped: null symbol
  { symbol: null, name: 'Null Sym', tradable: true, exchange: 'NYSE' },
]

// Expected result after filtering + dedup + sort (non-OTC, tradable, first-occurrence):
//   AAPL → 'Apple Inc.'  (MSFT sorts after AAPL)
//   MSFT → 'Microsoft Corp'
const EXPECTED: Array<[string, string]> = [
  ['AAPL', 'Apple Inc.'],
  ['MSFT', 'Microsoft Corp'],
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fetchAlpacaAssets', () => {
  it('returns sorted, deduped [symbol, name] pairs (non-OTC, tradable only)', async () => {
    const mock = await startMockAssets({ status: 200, body: SAMPLE_ASSETS })
    try {
      const result = await fetchAlpacaAssets('key', 'secret', { endpointUrl: mock.baseUrl })
      expect(result).toEqual(EXPECTED)
    } finally {
      await mock.close()
    }
  })

  it('includes OTC symbols when includeOtc=true', async () => {
    const mock = await startMockAssets({ status: 200, body: SAMPLE_ASSETS })
    try {
      const result = await fetchAlpacaAssets('key', 'secret', {
        endpointUrl: mock.baseUrl,
        includeOtc: true,
      })
      // PNKQ should now appear (tradable=true, exchange=OTC)
      const syms = result.map(([s]) => s)
      expect(syms).toContain('PNKQ')
      expect(syms).toContain('AAPL')
      expect(syms).toContain('MSFT')
      // still sorted ascending
      const sorted = [...syms].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      expect(syms).toEqual(sorted)
    } finally {
      await mock.close()
    }
  })

  it('throws on a non-200 response', async () => {
    const mock = await startMockAssets({ status: 403, body: 'forbidden', raw: true })
    try {
      await expect(
        fetchAlpacaAssets('key', 'secret', { endpointUrl: mock.baseUrl }),
      ).rejects.toThrow(/403/)
    } finally {
      await mock.close()
    }
  })
})

describe('buildWhitelist', () => {
  it('writes symbols.txt with correct content and returns pairs', async () => {
    const mock = await startMockAssets({ status: 200, body: SAMPLE_ASSETS })
    const tmpDir = mkdtempSync(join(tmpdir(), 'wsb-assets-test-'))
    try {
      const outPath = join(tmpDir, 'whitelist', 'symbols.txt')
      const result = await buildWhitelist('key', 'secret', {
        endpointUrl: mock.baseUrl,
        outPath,
      })

      expect(result).toEqual(EXPECTED)

      const content = readFileSync(outPath, 'utf8')

      // File must end with a newline
      expect(content.endsWith('\n')).toBe(true)

      const lines = content.split('\n')
      // All header lines start with '#'
      const headerLines = lines.filter((l) => l.startsWith('#'))
      expect(headerLines.length).toBeGreaterThan(0)
      for (const h of headerLines) expect(h.startsWith('#')).toBe(true)

      // Symbol lines (non-comment, non-empty)
      const symLines = lines.filter((l) => l.length > 0 && !l.startsWith('#'))
      expect(symLines).toEqual(['AAPL', 'MSFT'])

      // Header mentions non-OTC (default includeOtc=false)
      expect(content).toContain('non-OTC')
    } finally {
      await mock.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('header does not mention non-OTC when includeOtc=true', async () => {
    const mock = await startMockAssets({ status: 200, body: SAMPLE_ASSETS })
    const tmpDir = mkdtempSync(join(tmpdir(), 'wsb-assets-test-otc-'))
    try {
      const outPath = join(tmpDir, 'symbols.txt')
      await buildWhitelist('key', 'secret', {
        endpointUrl: mock.baseUrl,
        outPath,
        includeOtc: true,
      })
      const content = readFileSync(outPath, 'utf8')
      expect(content).not.toContain('non-OTC')
    } finally {
      await mock.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
