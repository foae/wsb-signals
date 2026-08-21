/** Agent analysis read-path integration tests on real Postgres. */
import {
  cycleRuns, empiricalFeatures, playInterpretations, plays, signals, tickerNames,
} from '@wsb/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  PlayAuditSchema, TickerDossierSchema, readPlayAudit, readTickerDossier,
} from '../server/utils/analysis'
import { startPg, type PgHarness } from './helpers/pg'

let pg: PgHarness
beforeAll(async () => { pg = await startPg() }, 120_000)
afterAll(async () => { await pg?.stop() })
beforeEach(async () => { await pg.reset() })

const W0 = 1_780_002_000
const W1 = W0 + 3600
const W2 = W1 + 3600
const RUN_AT = 1_780_000_123_000

async function seed(): Promise<void> {
  await pg.db.insert(tickerNames).values({ symbol: 'NVDA', name: 'NVIDIA Corp.' })
  await pg.db.insert(cycleRuns).values([
    { windowStart: W0, generatedAt: W0 + 300, totalMentions: 20, quiet: false, capped: false, newestUtc: W0 + 250, status: 'complete' },
    { windowStart: W1, generatedAt: W1 + 300, totalMentions: 30, quiet: false, capped: true, newestUtc: W1 + 250, status: 'complete' },
    { windowStart: W2, generatedAt: W2 + 300, totalMentions: 40, quiet: false, capped: false, newestUtc: W2 + 250, status: 'complete' },
  ])
  await pg.db.insert(empiricalFeatures).values([
    { ticker: 'NVDA', windowStart: W0, mentions: 2, authors: 2, sov: 0.1, velocity: null, accel: null, z: null, netDir: 0.5, ddCount: 0, baselineStatus: 'cold', hE: 0.2 },
    { ticker: 'NVDA', windowStart: W1, mentions: 6, authors: 5, sov: 0.2, velocity: 4, accel: null, z: 1, netDir: 0.8, ddCount: 1, baselineStatus: 'ready', hE: 0.7 },
    { ticker: 'NVDA', windowStart: W2, mentions: 9, authors: 8, sov: 0.3, velocity: 3, accel: -1, z: 2, netDir: 0.9, ddCount: 2, baselineStatus: 'ready', hE: 0.9 },
  ])
  await pg.db.insert(signals).values([
    { ticker: 'NVDA', windowStart: W0, hE: 0.2, hM: 0.1, divergence: 0.1, quadrant: 'QUIET', rank: 4, rankDelta: null },
    { ticker: 'NVDA', windowStart: W1, hE: 0.7, hM: 0.5, divergence: 0.2, quadrant: 'CONFIRMED', rank: 1, rankDelta: 3 },
    { ticker: 'NVDA', windowStart: W2, hE: 0.9, hM: 0.7, divergence: 0.2, quadrant: 'CONFIRMED', rank: 1, rankDelta: 0 },
  ])

  await pg.db.insert(plays).values([
    {
      id: 'play1', createdUtc: W1 + 100, capturedAt: W1 + 200, publishedAt: W1 + 400,
      status: 'published', attempts: 0, mediaStatus: 'none', author: 'ape', flair: 'YOLO',
      title: 'low-confidence NVDA play', primaryTicker: 'NVDA', category: 'unclassifiable',
      tags: ['options'], confidence: 0.4, pnlAbs: 123, pnlPct: 12, realized: false,
      currentInterpretationAt: RUN_AT, interpreterVersion: 'interpreter-v1', taxonomyVersion: 'taxonomy-v1',
    },
    {
      id: 'play2', createdUtc: W0 + 100, capturedAt: W0 + 200, publishedAt: W0 + 400,
      status: 'published', attempts: 0, mediaStatus: 'none', author: 'ape2', flair: 'Gain',
      title: 'NVDA play with drifted anchor', primaryTicker: 'NVDA', category: 'lucky-timing',
      tags: [], confidence: 0.8, currentInterpretationAt: RUN_AT + 1,
      interpreterVersion: 'interpreter-v1', taxonomyVersion: 'taxonomy-v1',
    },
    {
      id: 'play3', createdUtc: null, capturedAt: W1 + 50, publishedAt: W1 + 400,
      status: 'published', attempts: 0, mediaStatus: 'none', author: 'ape3', flair: 'YOLO',
      title: 'NVDA play without post time', primaryTicker: 'NVDA', category: 'lucky-timing',
      tags: [], confidence: 0.7, currentInterpretationAt: RUN_AT + 2,
      interpreterVersion: 'interpreter-v1', taxonomyVersion: 'taxonomy-v1',
    },
    { id: 'fail1', createdUtc: W1 + 200, capturedAt: W1 + 200, status: 'failed', attempts: 4 },
    { id: 'dead1', createdUtc: W1 + 300, capturedAt: W1 + 300, status: 'discarded', attempts: 1 },
  ])
  await pg.db.insert(playInterpretations).values({
    playId: 'play1', runAt: RUN_AT, model: 'model-x', promptVersion: 'interpret-v1',
    output: { category: 'unclassifiable', tags: ['options'], summary: 'summary', tldr: 'tldr' },
    evidence: {
      evidence_version: 'evidence-v1', ticker: 'NVDA', ticker_outcome: 'validated', direction: 'bullish',
      anchor_utc: String(W1 + 100), anchor_basis: 'post_time', post_utc: W1 + 100,
      radar: { window_start: W1, heat: { rank: 1, sov: 0.2, h_e: 0.7, mentions: 6, authors: 5 }, mentions_24h: 6, authors_24h: 5, mentions_72h: 8, authors_72h: 7, note: null },
      herd: { direction: 'bull', distinct_authors: 4, threshold: 3, lookback_hours: 24, eligible: true },
      market: null, note: null,
    },
  })
  await pg.db.insert(playInterpretations).values({
    playId: 'play2', runAt: RUN_AT + 1, model: 'model-x', promptVersion: 'interpret-v1',
    output: { category: 'lucky-timing', tags: [], summary: 'summary', tldr: 'tldr' },
    evidence: {
      evidence_version: 'evidence-v1', ticker: 'NVDA', anchor_utc: 'not-a-number',
      anchor_basis: 'opened_at',
    },
  })
  await pg.db.insert(playInterpretations).values({
    playId: 'play3', runAt: RUN_AT + 2, model: 'model-x', promptVersion: 'interpret-v1',
    output: { category: 'lucky-timing', tags: [], summary: 'summary', tldr: 'tldr' },
    evidence: {
      evidence_version: 'evidence-v1', ticker: 'NVDA', anchor_utc: W1 + 50,
      anchor_basis: 'opened_at',
    },
  })
}

describe('agent analysis reads', () => {
  it('returns only finalized heat and does not inherit board display filters', async () => {
    await seed()
    const dossier = await readTickerDossier(pg.db, 'NVDA', { from: W0, to: W2 + 3600 })

    expect(dossier.meta.asOfWindowStart).toBe(W1)
    expect(dossier.heat.map((point) => point.windowStart)).toEqual([W0, W1])
    expect(dossier.heat[1]).toMatchObject({ capped: true, baselineStatus: 'ready', rank: 1, hE: 0.7 })
    expect(dossier.ticker).toMatchObject({ symbol: 'NVDA', known: true })
    expect(dossier.plays.map((play) => play.id)).toEqual(['play1', 'play3', 'play2'])
    expect(dossier.plays[0]).toMatchObject({ confidence: 0.4, category: 'unclassifiable', anchorUtc: W1 + 100 })
    expect(dossier.plays[0]?.evidence?.evidence_version).toBe('evidence-v1')
    expect(dossier.plays[1]).toMatchObject({ anchorUtc: W1 + 50, anchorBasis: 'opened_at' })
    expect(dossier.plays[2]).toMatchObject({ anchorUtc: W0 + 100, anchorBasis: 'post_time' })
    expect(dossier.corpus).toEqual({
      basis: 'createdUtc',
      byStatus: [
        { status: 'discarded', count: 1 },
        { status: 'failed', count: 1 },
        { status: 'published', count: 2 },
      ],
      excludedGlobal: { unknownCreatedUtc: 1 },
    })
    expect(() => TickerDossierSchema.parse(dossier)).not.toThrow()
  })

  it('reports the latest finalized window included by a historical range', async () => {
    await seed()
    const dossier = await readTickerDossier(pg.db, 'NVDA', { from: W0, to: W1 })

    expect(dossier.meta.asOfWindowStart).toBe(W0)
    expect(dossier.heat.map((point) => point.windowStart)).toEqual([W0])
  })

  it('signals unknown tickers and truncates oversized play sets explicitly', async () => {
    await seed()
    const unknown = await readTickerDossier(pg.db, 'ZZZZ', { from: W0, to: W2 + 3600 })
    expect(unknown.ticker).toEqual({ symbol: 'ZZZZ', name: null, known: false })
    expect(unknown.plays).toEqual([])
    expect(unknown.heat.every((point) => point.mentions == null && point.rank == null)).toBe(true)

    await pg.db.insert(plays).values(Array.from({ length: 198 }, (_, index) => ({
      id: `cap${String(index).padStart(3, '0')}`,
      createdUtc: W0 + 400 + index,
      capturedAt: W0 + 400 + index,
      status: 'published' as const,
      attempts: 0,
      mediaStatus: 'none',
      primaryTicker: 'NVDA',
    })))
    const capped = await readTickerDossier(pg.db, 'NVDA', { from: W0, to: W2 + 3600 })
    expect(capped.plays).toHaveLength(200)
    expect(capped.playsTruncated).toBe(true)
  })

  it('audits the served interpretation and nearby heat in one response', async () => {
    await seed()
    const audit = await readPlayAudit(pg.db, 'play1', { beforeHours: 2, afterHours: 2 })

    expect(audit?.detail.interpretation).toMatchObject({ runAt: RUN_AT, model: 'model-x' })
    expect(audit?.context).toMatchObject({ ticker: 'NVDA', anchorUtc: W1 + 100, anchorBasis: 'post_time' })
    expect(audit?.context.heat.map((point) => point.windowStart)).toEqual([W0, W1])
    expect(audit?.outcomes).toEqual({ status: 'tracking_not_implemented', trackStatus: null, marks: null })

    const anchorBucket = await readPlayAudit(pg.db, 'play1', { beforeHours: 0, afterHours: 0 })
    expect(anchorBucket?.context.range).toEqual({ from: W1, to: W2, semantics: '[from,to)' })
    expect(anchorBucket?.context.heat.map((point) => point.windowStart)).toEqual([W1])
    expect(() => PlayAuditSchema.parse(audit)).not.toThrow()
  })
})
