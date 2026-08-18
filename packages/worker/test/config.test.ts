import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { buildExtractor, buildMarket, buildSource, findRoot, loadConfig } from '../src/config'

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
    expect(worker.aggregate.baselineLookbackSeconds).toBe(15724800) // 26-week z-baseline bound (porting-spec §2.7)
    expect(worker.aggregate.minAuthorsFull).toBe(3)
    expect(worker.market.topN).toBe(25)
    expect(worker.market.screenerTop).toBe(25)
    expect(worker.market.weights.ret).toBeCloseTo(0.5, 9)
  })

  it('parses the [plays] block (P1) — minute knobs flattened to seconds, media dir under data_dir', () => {
    const { worker } = loadConfig(ROOT)
    expect(worker.plays.enabled).toBe(true)
    expect([...worker.plays.flairs].sort()).toEqual(['Gain', 'Loss', 'Verified Trade', 'YOLO'])
    expect(worker.plays.queueIntervalSeconds).toBe(60)
    expect(worker.plays.maxAttempts).toBe(4)
    expect(worker.plays.leaseSeconds).toBe(600)
    expect(worker.plays.mediaRetrySeconds).toBe(600)
    expect(worker.plays.maxImagesStored).toBe(20)
    expect(worker.plays.maxImageBytes).toBe(10 * 1024 * 1024)
    expect(worker.plays.mediaDir).toBe(join(ROOT, 'data', 'media', 'plays'))
    expect(worker.plays.redditUserAgent.length).toBeGreaterThan(0)
  })

  it('parses the [plays.llm] block (P2) — the extract model carries REAL positive prices (set at the gate)', () => {
    const { worker } = loadConfig(ROOT)
    const llm = worker.plays.llm
    expect(llm.provider).toBe('openai')
    expect(llm.extractModel.length).toBeGreaterThan(0)
    expect(llm.maxPlaysPerTick).toBe(5)
    expect(llm.maxOutputTokens).toBe(6000)
    expect(llm.dailyBudgetUsd).toBe(5.0)
    expect(worker.plays.maxImagesLlm).toBe(8)
    expect(worker.plays.maxRequestBytes).toBe(24 * 1024 * 1024)
    // Real prices were deliberately set at the P2 gate (2026-08-18); a regression to 0.0 would
    // re-park the queue (fail-closed), a NEGATIVE/absent entry likewise refuses — assert usable.
    const p = llm.prices[llm.extractModel]!
    expect(p.input).toBeGreaterThan(0)
    expect(p.output).toBeGreaterThan(0)
  })

  it('builds a CASHTAG-ONLY extractor when the whitelist is missing (fails closed)', () => {
    const { raw } = loadConfig(ROOT)
    raw.extract.whitelist_path = 'whitelist/__definitely_missing__.txt'
    const ext = buildExtractor(raw, ROOT)
    expect(ext.extract('NVDA to the moon')).toEqual([]) // bare token rejected — NOT degraded to open extraction
    expect(ext.extract('$NVDA calls')).toEqual(['NVDA']) // $-cashtag still accepted
  })

  it('findRoot walks up from a subdir to the dir holding config.toml', () => {
    // The worker runs with cwd=packages/worker (pnpm -C / the container), where config.toml does NOT live;
    // findRoot must walk up to the repo root so loadConfig finds config.toml + whitelist/ regardless of cwd.
    const root = ROOT.replace(/\/+$/, '') // ROOT carries a trailing slash; findRoot returns without one
    expect(findRoot(join(root, 'packages', 'worker'))).toBe(root)
    expect(findRoot(root)).toBe(root)
  })

  it('builds the source + gates the market client on creds', () => {
    const { raw } = loadConfig(ROOT)
    expect(buildSource(raw).name).toBe('arctic_shift')
    expect(buildMarket(raw, {})).toBeNull() // no creds → empirical-only
    expect(buildMarket(raw, { ALPACA_API_KEY: 'k', ALPACA_API_SECRET: 's' })?.name).toBe('alpaca')
  })
})
