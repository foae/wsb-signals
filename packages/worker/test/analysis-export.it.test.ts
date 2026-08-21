import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { playInterpretations, plays } from '@wsb/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runExport } from '../src/analysis/plays-export'
import { startPg, type PgHarness } from './helpers/pg'

const FROM = 1_780_000_000
const TO = FROM + 10_000
const RUN_AT = FROM * 1000

let pg: PgHarness
let outputDir: string
let priorAnalysisUrl: string | undefined

beforeAll(async () => {
  pg = await startPg()
  outputDir = await mkdtemp(join(tmpdir(), 'wsb-analysis-export-'))
  priorAnalysisUrl = process.env.ANALYSIS_DATABASE_URL
  process.env.ANALYSIS_DATABASE_URL = pg.container.getConnectionUri()

  await pg.db.insert(plays).values(Array.from({ length: 251 }, (_, index) => ({
    id: `p${String(index).padStart(4, '0')}`,
    createdUtc: FROM + index,
    capturedAt: FROM + index,
    status: 'published' as const,
    attempts: 0,
    mediaStatus: 'none',
    primaryTicker: 'NVDA',
    title: index === 0 ? '=SUM(1,2)' : null,
  })))
  await pg.db.insert(plays).values([
    {
      id: 'anchorednull',
      createdUtc: null,
      capturedAt: FROM,
      status: 'published',
      attempts: 0,
      mediaStatus: 'none',
      primaryTicker: 'NVDA',
      currentInterpretationAt: RUN_AT,
    },
    {
      id: 'malformed',
      createdUtc: FROM + 600,
      capturedAt: FROM + 600,
      status: 'published',
      attempts: 0,
      mediaStatus: 'none',
      primaryTicker: 'NVDA',
      currentInterpretationAt: RUN_AT + 1,
    },
  ])
  await pg.db.insert(playInterpretations).values([
    {
      playId: 'anchorednull',
      runAt: RUN_AT,
      evidence: {
        evidence_version: 'evidence-v1',
        ticker: 'NVDA',
        anchor_utc: FROM + 500,
        anchor_basis: 'opened_at',
      },
      output: {},
    },
    {
      playId: 'malformed',
      runAt: RUN_AT + 1,
      evidence: {
        evidence_version: 'evidence-v1',
        ticker: 'NVDA',
        anchor_utc: '99999999999999999999',
        anchor_basis: 'opened_at',
      },
      output: {},
    },
  ])
}, 120_000)

afterAll(async () => {
  if (priorAnalysisUrl == null) delete process.env.ANALYSIS_DATABASE_URL
  else process.env.ANALYSIS_DATABASE_URL = priorAnalysisUrl
  await pg?.stop()
  await rm(outputDir, { recursive: true, force: true })
})

describe('plays export snapshot', () => {
  it('paginates beyond one page and makes post-time versus anchor-time cohorts explicit', async () => {
    const postPath = join(outputDir, 'post.json')
    const postResult = await runExport([
      '--from', String(FROM), '--to', String(TO), '--range-basis', 'post',
      '--format', 'json', '--out', postPath,
    ])
    const post = JSON.parse(await readFile(postPath, 'utf8')) as {
      range: { basis: string; field: string }
      excludedGlobal: { unknownBasisTime: number }
      outcomeCapability: { marksAvailable: boolean }
      records: Array<{ id: string; outcome: { marks: unknown } }>
    }

    expect(postResult).toMatchObject({
      records: 252,
      rangeBasis: 'post',
      excludedUnknownBasisTimeGlobal: 1,
    })
    expect(post.range).toEqual(expect.objectContaining({ basis: 'post', field: 'createdUtc' }))
    expect(post.excludedGlobal.unknownBasisTime).toBe(1)
    expect(post.outcomeCapability.marksAvailable).toBe(false)
    expect(post.records).toHaveLength(252)
    expect(post.records.every((record) => record.outcome.marks === null)).toBe(true)

    const anchorPath = join(outputDir, 'anchor.json')
    const anchorResult = await runExport([
      '--from', String(FROM), '--to', String(TO), '--range-basis', 'anchor',
      '--format', 'json', '--out', anchorPath,
    ])
    const anchor = JSON.parse(await readFile(anchorPath, 'utf8')) as {
      range: { basis: string; field: string }
      records: Array<{ id: string; anchorUtc: number | null; anchorBasis: string | null }>
    }

    expect(anchorResult).toMatchObject({
      records: 253,
      rangeBasis: 'anchor',
      excludedUnknownBasisTimeGlobal: 0,
    })
    expect(anchor.range).toEqual(expect.objectContaining({ basis: 'anchor', field: 'anchorUtc' }))
    expect(anchor.records.find((record) => record.id === 'anchorednull')).toMatchObject({
      anchorUtc: FROM + 500,
      anchorBasis: 'opened_at',
    })
    expect(anchor.records.find((record) => record.id === 'malformed')).toMatchObject({
      anchorUtc: FROM + 600,
      anchorBasis: 'post_time',
    })
  })


  it('writes guarded CSV, refuses overwrites, and cleans partial files after connection failure', async () => {
    const csvPath = join(outputDir, 'plays.csv')
    const result = await runExport([
      '--from', String(FROM), '--to', String(TO), '--format', 'csv', '--out', csvPath,
    ])
    const csv = await readFile(csvPath, 'utf8')
    expect(result.records).toBe(252)
    expect(csv).toContain(`"'=SUM(1,2)"`)
    await expect(runExport([
      '--from', String(FROM), '--to', String(TO), '--format', 'csv', '--out', csvPath,
    ])).rejects.toThrow(/output already exists/)
    const failedPath = join(outputDir, 'failed.json')
    await pg.pool.query('ALTER TABLE play_links RENAME TO play_links_unavailable')
    try {
      await expect(runExport([
        '--from', String(FROM), '--to', String(TO), '--format', 'json', '--out', failedPath,
      ])).rejects.toThrow(/play_links/)
    } finally {
      await pg.pool.query('ALTER TABLE play_links_unavailable RENAME TO play_links')
    }
    const files = await readdir(outputDir)
    expect(files).not.toContain('failed.json')
    expect(files.some((file) => file.includes('.partial-'))).toBe(false)
  })
})
