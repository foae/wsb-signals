import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { buildExtractor, buildMarket, buildSource, loadConfig } from '../src/config'

// Slice-6 config wiring: the worker reads the SAME committed config.toml (parity tunables) and builds the
// extractor with the SAME fail-closed rule as `cli._build_extractor`.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url)) // repo root (config.toml lives here)

describe('config loading', () => {
  it('parses config.toml into the flattened WorkerConfig', () => {
    const { worker } = loadConfig(ROOT)
    expect(worker.windowSeconds).toBe(3600)
    expect(worker.pollSeconds).toBe(300)
    expect(worker.minPollGapSeconds).toBe(60)
    expect(worker.minWindowMentions).toBe(20)
    expect(worker.maxStalenessSeconds).toBe(1800)
    expect(worker.bots.has('AutoModerator')).toBe(true)
    expect(worker.aggregate.weights.sov).toBeCloseTo(0.35, 9)
    expect(worker.aggregate.minSamplesReady).toBe(8)
    expect(worker.aggregate.minAuthorsFull).toBe(3)
    expect(worker.market.topN).toBe(25)
    expect(worker.market.screenerTop).toBe(25)
    expect(worker.market.weights.ret).toBeCloseTo(0.5, 9)
  })

  it('builds a CASHTAG-ONLY extractor when the whitelist is missing (fails closed)', () => {
    const { raw } = loadConfig(ROOT)
    raw.extract.whitelist_path = 'whitelist/__definitely_missing__.txt'
    const ext = buildExtractor(raw, ROOT)
    expect(ext.extract('NVDA to the moon')).toEqual([]) // bare token rejected — NOT degraded to open extraction
    expect(ext.extract('$NVDA calls')).toEqual(['NVDA']) // $-cashtag still accepted
  })

  it('builds the source + gates the market client on creds', () => {
    const { raw } = loadConfig(ROOT)
    expect(buildSource(raw).name).toBe('arctic_shift')
    expect(buildMarket(raw, {})).toBeNull() // no creds → empirical-only
    expect(buildMarket(raw, { ALPACA_API_KEY: 'k', ALPACA_API_SECRET: 's' })?.name).toBe('alpaca')
  })
})
