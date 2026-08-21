/**
 * `plays-export` — snapshot-consistent joined export for offline agent analysis (plays-product §5).
 *
 * The command deliberately refuses the worker's writer `DATABASE_URL`: use ANALYSIS_DATABASE_URL or
 * NUXT_DATABASE_URL, both intended for the provisioned read-only role. The transaction is READ ONLY
 * even if an operator supplies an over-privileged DSN by mistake.
 */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { WriteStream } from 'node:fs'
import { access, link, mkdir, open, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { finished } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'

import {
  ANALYSIS_CAVEAT_CODES, ANALYSIS_MAX_EPOCH_SECONDS, ANALYSIS_MIN_EPOCH_SECONDS,
  ANALYSIS_QUERY_TIMEOUT_SECONDS, ANALYSIS_SCHEMA_VERSION, OUTCOME_TRACKING_CAPABILITY,
} from '@wsb/shared'
import { Client, type QueryResult } from 'pg'

import { findRoot, loadConfig } from '../config'
import { assertOptions, parseArgs, parseEpoch, stringOption } from './client'

const PAGE_SIZE = 250
const MAX_EXPORT_RANGE_SECONDS = 366 * 86_400
const FORMATS = { json: true, csv: true } as const
const RANGE_BASES = { post: true, anchor: true } as const

type ExportFormat = keyof typeof FORMATS
type RangeBasis = keyof typeof RANGE_BASES

type PgExportRow = Record<string, unknown> & {
  id: string
  created_utc: string | number | null
  analysis_anchor_utc: string | number | null
  analysis_anchor_basis: string | null
  range_utc: string | number
}

export interface ExportRecord {
  id: string
  createdUtc: number | null
  anchorUtc: number | null
  anchorBasis: string | null
  capturedAt: number | null
  publishedAt: number | null
  author: string | null
  flair: string | null
  title: string | null
  selftext: string | null
  permalink: string | null
  url: string | null
  media: unknown
  mediaStatus: string | null
  score: number | null
  numComments: number | null
  removed: boolean | null
  primaryTicker: string | null
  category: string | null
  tags: string[]
  confidence: number | null
  pnlAbs: number | null
  pnlPct: number | null
  realized: boolean | null
  summary: string | null
  tldr: string | null
  extractorVersion: string | null
  interpreterVersion: string | null
  taxonomyVersion: string | null
  trackStatus: string | null
  trackUntil: number | null
  extraction: {
    runAt: number
    model: string | null
    promptVersion: string | null
    output: unknown
    tokensIn: number | null
    tokensOut: number | null
    costUsd: number | null
  } | null
  interpretation: {
    runAt: number
    model: string | null
    promptVersion: string | null
    evidence: unknown
    output: unknown
    tokensIn: number | null
    tokensOut: number | null
    costUsd: number | null
  } | null
  outcome: {
    status: typeof OUTCOME_TRACKING_CAPABILITY.status
    marks: null
    links: unknown[] | null
  }
}

const EVIDENCE_ANCHOR_SQL = `case
  when pi.evidence->>'anchor_utc' ~ '^[0-9]{10}$' then case
    when (pi.evidence->>'anchor_utc')::bigint between ${ANALYSIS_MIN_EPOCH_SECONDS} and ${ANALYSIS_MAX_EPOCH_SECONDS}
      then (pi.evidence->>'anchor_utc')::bigint end
  end`
const ANCHOR_SQL = `coalesce(${EVIDENCE_ANCHOR_SQL}, p.created_utc)`

function exportQuery(rangeBasis: RangeBasis): string {
  const rangeExpr = rangeBasis === 'anchor' ? ANCHOR_SQL : 'p.created_utc'
  return `
select
  p.id, p.created_utc, ${ANCHOR_SQL} as analysis_anchor_utc,
  case when ${EVIDENCE_ANCHOR_SQL} is not null
    then coalesce(nullif(pi.evidence->>'anchor_basis', ''), 'post_time')
    when p.created_utc is not null then 'post_time'
    else null
  end as analysis_anchor_basis,
  ${rangeExpr} as range_utc,
  p.captured_at, p.published_at, p.author, p.flair, p.title, p.selftext,
  p.permalink, p.url, p.media, p.media_status, p.score, p.num_comments, p.removed,
  p.primary_ticker, p.category, p.tags, p.confidence, p.pnl_abs, p.pnl_pct, p.realized,
  p.summary, p.tldr, p.extractor_version, p.interpreter_version, p.taxonomy_version,
  p.track_status, p.track_until,
  pe.run_at as extraction_run_at, pe.model as extraction_model,
  pe.prompt_version as extraction_prompt_version, pe.output as extraction_output,
  pe.tokens_in as extraction_tokens_in, pe.tokens_out as extraction_tokens_out,
  pe.cost_usd as extraction_cost_usd,
  pi.run_at as interpretation_run_at, pi.model as interpretation_model,
  pi.prompt_version as interpretation_prompt_version, pi.evidence as interpretation_evidence,
  pi.output as interpretation_output, pi.tokens_in as interpretation_tokens_in,
  pi.tokens_out as interpretation_tokens_out, pi.cost_usd as interpretation_cost_usd,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'resolutionPlayId', pl.resolution_play_id, 'kind', pl.kind, 'linkedAt', pl.linked_at
    ) order by pl.linked_at, pl.resolution_play_id)
    from play_links pl where pl.play_id = p.id
  ), '[]'::jsonb) as links
from plays p
left join play_extractions pe
  on pe.play_id = p.id and pe.run_at = p.current_extraction_at
left join play_interpretations pi
  on pi.play_id = p.id and pi.run_at = p.current_interpretation_at
where p.status = 'published'
  and ${rangeExpr} >= $1 and ${rangeExpr} < $2
  and ($3::bigint is null or ${rangeExpr} < $3 or (${rangeExpr} = $3 and p.id < $4))
order by ${rangeExpr} desc, p.id desc
limit $5`
}

function excludedUnknownQuery(rangeBasis: RangeBasis): string {
  const rangeExpr = rangeBasis === 'anchor' ? ANCHOR_SQL : 'p.created_utc'
  return `
select count(*)::int as count
from plays p
left join play_interpretations pi
  on pi.play_id = p.id and pi.run_at = p.current_interpretation_at
where p.status = 'published' and ${rangeExpr} is null`
}

const num = (value: unknown): number | null => value == null ? null : Number(value)
const str = (value: unknown): string | null => typeof value === 'string' ? value : null

export function mapExportRow(row: PgExportRow): ExportRecord {
  const extractionRunAt = num(row.extraction_run_at)
  const interpretationRunAt = num(row.interpretation_run_at)
  return {
    id: row.id,
    anchorUtc: num(row.analysis_anchor_utc),
    anchorBasis: str(row.analysis_anchor_basis),
    createdUtc: num(row.created_utc),
    capturedAt: num(row.captured_at),
    publishedAt: num(row.published_at),
    author: str(row.author),
    flair: str(row.flair),
    title: str(row.title),
    selftext: str(row.selftext),
    permalink: str(row.permalink),
    url: str(row.url),
    media: row.media ?? null,
    mediaStatus: str(row.media_status),
    score: num(row.score),
    numComments: num(row.num_comments),
    removed: typeof row.removed === 'boolean' ? row.removed : null,
    primaryTicker: str(row.primary_ticker),
    category: str(row.category),
    tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    confidence: num(row.confidence),
    pnlAbs: num(row.pnl_abs),
    pnlPct: num(row.pnl_pct),
    realized: typeof row.realized === 'boolean' ? row.realized : null,
    summary: str(row.summary),
    tldr: str(row.tldr),
    extractorVersion: str(row.extractor_version),
    interpreterVersion: str(row.interpreter_version),
    taxonomyVersion: str(row.taxonomy_version),
    trackStatus: str(row.track_status),
    trackUntil: num(row.track_until),
    extraction: extractionRunAt == null ? null : {
      runAt: extractionRunAt,
      model: str(row.extraction_model),
      promptVersion: str(row.extraction_prompt_version),
      output: row.extraction_output ?? null,
      tokensIn: num(row.extraction_tokens_in),
      tokensOut: num(row.extraction_tokens_out),
      costUsd: num(row.extraction_cost_usd),
    },
    interpretation: interpretationRunAt == null ? null : {
      runAt: interpretationRunAt,
      model: str(row.interpretation_model),
      promptVersion: str(row.interpretation_prompt_version),
      evidence: row.interpretation_evidence ?? null,
      output: row.interpretation_output ?? null,
      tokensIn: num(row.interpretation_tokens_in),
      tokensOut: num(row.interpretation_tokens_out),
      costUsd: num(row.interpretation_cost_usd),
    },
    outcome: {
      status: OUTCOME_TRACKING_CAPABILITY.status,
      marks: null,
      links: Array.isArray(row.links) ? row.links : null,
    },
  }
}

const CSV_COLUMNS = [
  'id', 'createdUtc', 'anchorUtc', 'anchorBasis', 'capturedAt', 'publishedAt', 'author', 'flair',
  'title', 'selftext', 'permalink', 'url', 'mediaStatus', 'score', 'numComments', 'removed',
  'primaryTicker', 'category', 'confidence', 'pnlAbs', 'pnlPct', 'realized', 'summary', 'tldr',
  'extractorVersion', 'interpreterVersion', 'taxonomyVersion', 'trackStatus', 'trackUntil',
  'tagsJson', 'mediaJson', 'extractionJson', 'interpretationJson', 'marksJson', 'linksJson',
] as const

function csvCell(value: unknown): string {
  if (value == null) return ''
  const raw = typeof value === 'string' ? value : String(value)
  // Spreadsheet programs evaluate cells beginning with these characters as formulas.
  const text = typeof value === 'string' && /^[\t\r ]*[=+\-@]/.test(raw) ? `'${raw}` : raw
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function exportRecordToCsv(record: ExportRecord): string {
  const values: Record<(typeof CSV_COLUMNS)[number], unknown> = {
    id: record.id,
    createdUtc: record.createdUtc,
    anchorUtc: record.anchorUtc,
    anchorBasis: record.anchorBasis,
    capturedAt: record.capturedAt,
    publishedAt: record.publishedAt,
    author: record.author,
    flair: record.flair,
    title: record.title,
    selftext: record.selftext,
    permalink: record.permalink,
    url: record.url,
    mediaStatus: record.mediaStatus,
    score: record.score,
    numComments: record.numComments,
    removed: record.removed,
    primaryTicker: record.primaryTicker,
    category: record.category,
    confidence: record.confidence,
    pnlAbs: record.pnlAbs,
    pnlPct: record.pnlPct,
    realized: record.realized,
    summary: record.summary,
    tldr: record.tldr,
    extractorVersion: record.extractorVersion,
    interpreterVersion: record.interpreterVersion,
    taxonomyVersion: record.taxonomyVersion,
    trackStatus: record.trackStatus,
    trackUntil: record.trackUntil,
    tagsJson: JSON.stringify(record.tags),
    mediaJson: JSON.stringify(record.media),
    extractionJson: JSON.stringify(record.extraction),
    interpretationJson: JSON.stringify(record.interpretation),
    marksJson: JSON.stringify(record.outcome.marks),
    linksJson: JSON.stringify(record.outcome.links),
  }
  return `${CSV_COLUMNS.map((column) => csvCell(values[column])).join(',')}\n`
}

async function writeChunk(stream: WriteStream, chunk: string): Promise<void> {
  if (!stream.write(chunk)) await once(stream, 'drain')
}

function stamp(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10).replaceAll('-', '')
}

export async function runExport(argv: readonly string[]): Promise<{
  path: string
  records: number
  rangeBasis: RangeBasis
  excludedUnknownBasisTimeGlobal: number
}> {
  const { positionals, options } = parseArgs(argv, {})
  assertOptions(options, ['from', 'to', 'format', 'range-basis', 'out'])
  if (positionals.length !== 0) throw new Error('plays-export takes options only')
  const fromRaw = stringOption(options, 'from')
  const toRaw = stringOption(options, 'to')
  if (fromRaw == null || toRaw == null) throw new Error('--from and --to are required')
  const from = parseEpoch(fromRaw, '--from')
  const to = parseEpoch(toRaw, '--to')
  if (to <= from) throw new Error('--to must be greater than --from')
  if (to - from > MAX_EXPORT_RANGE_SECONDS) throw new Error('export range exceeds 366 days; split it into bounded files')

  const formatRaw = stringOption(options, 'format') ?? 'json'
  if (!(formatRaw in FORMATS)) throw new Error('--format must be json or csv')
  const format = formatRaw as ExportFormat
  const rangeBasisRaw = stringOption(options, 'range-basis') ?? 'post'
  if (!(rangeBasisRaw in RANGE_BASES)) throw new Error('--range-basis must be post or anchor')
  const rangeBasis = rangeBasisRaw as RangeBasis

  const root = findRoot(process.cwd())
  const { env } = loadConfig(root)
  const databaseUrl = env.ANALYSIS_DATABASE_URL ?? env.NUXT_DATABASE_URL
  if (!databaseUrl) {
    throw new Error('ANALYSIS_DATABASE_URL or NUXT_DATABASE_URL is required (read-only role); DATABASE_URL is deliberately refused')
  }

  const defaultPath = join(root, 'data', 'exports', `plays-${rangeBasis}-${stamp(from)}-${stamp(to)}.${format}`)
  const outRaw = stringOption(options, 'out')
  const outputPath = outRaw == null ? defaultPath : (isAbsolute(outRaw) ? outRaw : resolve(root, outRaw))
  await mkdir(dirname(outputPath), { recursive: true })
  try {
    await access(outputPath)
    throw new Error(`output already exists: ${outputPath}`)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }

  const temporaryPath = `${outputPath}.partial-${process.pid}-${randomUUID()}`
  const client = new Client({
    connectionString: databaseUrl,
    application_name: 'wsb-plays-export',
    connectionTimeoutMillis: 5_000,
  })
  const output = await open(temporaryPath, 'wx')
  const stream = output.createWriteStream({ encoding: 'utf8' })
  const streamDone = finished(stream)
  void streamDone.catch(() => undefined)
  let published = false
  let count = 0
  let excludedUnknownBasisTimeGlobal = 0
  try {
    await client.connect()
    await client.query('begin isolation level repeatable read read only')
    await client.query(`set local statement_timeout = '${ANALYSIS_QUERY_TIMEOUT_SECONDS}s'`)
    const excluded = await client.query<{ count: number }>(excludedUnknownQuery(rangeBasis))
    excludedUnknownBasisTimeGlobal = Number(excluded.rows[0]?.count ?? 0)

    if (format === 'json') {
      await writeChunk(stream, `${JSON.stringify({
        schemaVersion: ANALYSIS_SCHEMA_VERSION,
        generatedAt: Math.floor(Date.now() / 1000),
        range: {
          from,
          to,
          semantics: '[from,to)',
          basis: rangeBasis,
          field: rangeBasis === 'post' ? 'createdUtc' : 'anchorUtc',
        },
        excludedGlobal: { unknownBasisTime: excludedUnknownBasisTimeGlobal },
        caveats: ANALYSIS_CAVEAT_CODES,
        outcomeCapability: OUTCOME_TRACKING_CAPABILITY,
      }).slice(0, -1)},\"records\":[`)
    } else {
      await writeChunk(stream, `${CSV_COLUMNS.join(',')}\n`)
    }

    const query = exportQuery(rangeBasis)
    let cursorRange: number | null = null
    let cursorId: string | null = null
    for (;;) {
      const result: QueryResult<PgExportRow> = await client.query<PgExportRow>(
        query, [from, to, cursorRange, cursorId, PAGE_SIZE],
      )
      if (result.rows.length === 0) break
      for (const raw of result.rows) {
        const record = mapExportRow(raw)
        if (format === 'json') {
          await writeChunk(stream, `${count === 0 ? '' : ','}${JSON.stringify(record)}`)
        } else {
          await writeChunk(stream, exportRecordToCsv(record))
        }
        count++
      }
      const last: PgExportRow = result.rows.at(-1)!
      cursorRange = Number(last.range_utc)
      cursorId = last.id
      if (result.rows.length < PAGE_SIZE) break
    }

    if (format === 'json') await writeChunk(stream, ']}\n')
    stream.end()
    await streamDone
    await client.query('commit')
    try {
      await link(temporaryPath, outputPath)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new Error(`output already exists: ${outputPath}`)
      }
      throw error
    }
    published = true
    await rm(temporaryPath).catch(() => undefined)
    return { path: outputPath, records: count, rangeBasis, excludedUnknownBasisTimeGlobal }
  } finally {
    if (!published) {
      stream.destroy()
      await streamDone.catch(() => undefined)
      await client.query('rollback').catch(() => undefined)
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
    await client.end().catch(() => undefined)
  }
}

async function main(): Promise<void> {
  try {
    const result = await runExport(process.argv.slice(2))
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main()
