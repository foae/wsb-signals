/**
 * Read-only, agent-facing analysis views (plays-product §5; plays-plan §8).
 *
 * These queries deliberately expose facts and provenance rather than conclusions. Ticker timelines use
 * only FINALIZED radar windows: a window is final when a later `cycle_runs` row exists, matching the
 * evidence builder's W−1 rule. Every multi-query response is one REPEATABLE READ / READ ONLY snapshot.
 * Analysis never inherits the board's confidence/category hiding: all published plays are eligible.
 */
import {
  ANALYSIS_CAVEAT_CODES, ANALYSIS_CAVEATS, ANALYSIS_MAX_EPOCH_SECONDS,
  ANALYSIS_MIN_EPOCH_SECONDS, ANALYSIS_QUERY_TIMEOUT_SECONDS, ANALYSIS_SCHEMA_VERSION,
  OUTCOME_TRACKING_CAPABILITY, WINDOW_SECONDS, analyticalFeatures, cycleRuns, empiricalFeatures,
  playInterpretations, plays, signals, tickerNames, type AnalysisCaveatCode,
} from '@wsb/shared'
import { and, asc, desc, eq, gte, isNull, lt, max, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { z } from 'zod'

import { EvidenceSchema, PlayDetailSchema, readPlayDetail } from './plays'

export const MAX_DOSSIER_RANGE_SECONDS = 180 * 86_400
export const DEFAULT_DOSSIER_RANGE_SECONDS = 7 * 86_400
export const MAX_DOSSIER_PLAYS = 200
export const MAX_ANALYSIS_CONCURRENCY = 2

declare global {
  var __wsbAnalysisActive: number | undefined
}

export class AnalysisBusyError extends Error {}

/** Preserve web capacity when agents fan out requests against the shared five-client pool. */
export async function withAnalysisSlot<T>(read: () => Promise<T>): Promise<T> {
  const active = globalThis.__wsbAnalysisActive ?? 0
  if (active >= MAX_ANALYSIS_CONCURRENCY) throw new AnalysisBusyError('analysis concurrency limit reached')
  globalThis.__wsbAnalysisActive = active + 1
  try {
    return await read()
  } finally {
    globalThis.__wsbAnalysisActive = Math.max(0, (globalThis.__wsbAnalysisActive ?? 1) - 1)
  }
}


export const CaveatCodeSchema = z.enum(ANALYSIS_CAVEAT_CODES)

const RESPONSE_CAVEATS: AnalysisCaveatCode[] = [...ANALYSIS_CAVEAT_CODES]

const EpochSchema = z.coerce.number().int()
  .min(ANALYSIS_MIN_EPOCH_SECONDS)
  .max(ANALYSIS_MAX_EPOCH_SECONDS)

export const TickerDossierQuerySchema = z.object({
  from: EpochSchema.optional(),
  to: EpochSchema.optional(),
})

export const PlayAuditQuerySchema = z.object({
  beforeHours: z.coerce.number().int().min(0).max(720).default(72),
  afterHours: z.coerce.number().int().min(0).max(720).default(24),
})

export type TickerDossierQuery = z.infer<typeof TickerDossierQuerySchema>
export type PlayAuditQuery = z.infer<typeof PlayAuditQuerySchema>

export class AnalysisInputError extends Error {}

/** Inclusive `from`, exclusive `to`; defaults to the last seven days and refuses unbounded reads. */
export function resolveDossierRange(
  query: TickerDossierQuery,
  now = Math.floor(Date.now() / 1000),
): { from: number; to: number } {
  const to = query.to ?? now
  const from = query.from ?? Math.max(0, to - DEFAULT_DOSSIER_RANGE_SECONDS)
  if (to <= from) throw new AnalysisInputError('to must be greater than from')
  if (to - from > MAX_DOSSIER_RANGE_SECONDS) {
    throw new AnalysisInputError(`range exceeds ${MAX_DOSSIER_RANGE_SECONDS} seconds (180 days)`)
  }
  return { from, to }
}

const AnalysisMetaSchema = z.object({
  schemaVersion: z.literal(ANALYSIS_SCHEMA_VERSION),
  generatedAt: z.number().int(),
  asOfWindowStart: z.number().int().nullable(),
  caveats: z.array(CaveatCodeSchema),
})

export const HeatPointSchema = z.object({
  windowStart: z.number().int(),
  generatedAt: z.number().int().nullable(),
  totalMentions: z.number().int().nullable(),
  quiet: z.boolean().nullable(),
  capped: z.boolean().nullable(),
  newestUtc: z.number().int().nullable(),
  mentions: z.number().int().nullable(),
  authors: z.number().int().nullable(),
  sov: z.number().nullable(),
  velocity: z.number().nullable(),
  accel: z.number().nullable(),
  z: z.number().nullable(),
  netDir: z.number().nullable(),
  ddCount: z.number().int().nullable(),
  baselineStatus: z.string().nullable(),
  hE: z.number().nullable(),
  hM: z.number().nullable(),
  divergence: z.number().nullable(),
  quadrant: z.string().nullable(),
  rank: z.number().int().nullable(),
  rankDelta: z.number().int().nullable(),
  ret: z.number().nullable(),
  rvol: z.number().nullable(),
  rvolConf: z.string().nullable(),
})

export const DossierPlaySchema = z.object({
  id: z.string(),
  createdUtc: z.number().int().nullable(),
  publishedAt: z.number().int().nullable(),
  author: z.string().nullable(),
  flair: z.string().nullable(),
  title: z.string().nullable(),
  permalink: z.string().nullable(),
  category: z.string().nullable(),
  tags: z.array(z.string()),
  confidence: z.number().nullable(),
  pnlAbs: z.number().nullable(),
  pnlPct: z.number().nullable(),
  realized: z.boolean().nullable(),
  summary: z.string().nullable(),
  tldr: z.string().nullable(),
  extractorVersion: z.string().nullable(),
  interpreterVersion: z.string().nullable(),
  taxonomyVersion: z.string().nullable(),
  interpretationRunAt: z.number().int().nullable(),
  anchorUtc: z.number().int().nullable(),
  anchorBasis: z.string().nullable(),
  evidence: EvidenceSchema,
})

const CorpusStatusSchema = z.object({ status: z.string(), count: z.number().int() })

const OutcomeCapabilitySchema = z.object({
  status: z.literal(OUTCOME_TRACKING_CAPABILITY.status),
  marksAvailable: z.literal(OUTCOME_TRACKING_CAPABILITY.marksAvailable),
})

export const TickerDossierSchema = z.object({
  meta: AnalysisMetaSchema,
  range: z.object({ from: z.number().int(), to: z.number().int(), semantics: z.literal('[from,to)') }),
  ticker: z.object({ symbol: z.string(), name: z.string().nullable(), known: z.boolean() }),
  heat: z.array(HeatPointSchema),
  plays: z.array(DossierPlaySchema),
  playsTruncated: z.boolean(),
  corpus: z.object({
    basis: z.literal('createdUtc'),
    byStatus: z.array(CorpusStatusSchema),
    excludedGlobal: z.object({ unknownCreatedUtc: z.number().int() }),
  }),
  outcomes: OutcomeCapabilitySchema,
})

const OutcomeStatusSchema = z.enum([
  'tracking_not_implemented', 'not_tracked', 'open_no_marks', 'open_with_marks',
  'expired', 'resolved-posted', 'untrackable',
])

const MarkSchema = z.object({
  positionId: z.string(), ts: z.number().int(), markValue: z.number().nullable(),
  pnlAbs: z.number().nullable(), pnlPct: z.number().nullable(), source: z.string().nullable(),
  feedConf: z.string().nullable(), note: z.string().nullable(),
})

export const PlayAuditSchema = z.object({
  meta: AnalysisMetaSchema,
  detail: PlayDetailSchema,
  context: z.object({
    ticker: z.string().nullable(),
    anchorUtc: z.number().int().nullable(),
    anchorBasis: z.string().nullable(),
    range: z.object({ from: z.number().int(), to: z.number().int(), semantics: z.literal('[from,to)') }).nullable(),
    heat: z.array(HeatPointSchema),
  }),
  outcomes: z.object({
    status: OutcomeStatusSchema,
    trackStatus: z.string().nullable(),
    marks: z.array(MarkSchema).nullable(),
  }),
})

export const AnalysisCatalogSchema = z.object({
  schemaVersion: z.literal(ANALYSIS_SCHEMA_VERSION),
  documentation: z.literal('design/plays-analysis.md'),
  capabilities: z.object({
    tickerDossier: z.literal(true),
    playAudit: z.literal(true),
    directPgExport: z.literal(true),
    outcomeMarks: z.literal(false),
    correlationPrimitive: z.literal('stored play evidence + finalized ticker dossier'),
  }),
  endpoints: z.array(z.object({ method: z.literal('GET'), path: z.string(), purpose: z.string() })),
  cli: z.array(z.string()),
  limits: z.object({
    dossierRangeDays: z.number().int(),
    dossierPlays: z.number().int(),
    concurrentReads: z.number().int(),
    retryAfterSeconds: z.number().int(),
  }),
  caveats: z.record(CaveatCodeSchema, z.string()),
})

export type TickerDossier = z.infer<typeof TickerDossierSchema>
export type PlayAudit = z.infer<typeof PlayAuditSchema>
export type AnalysisCatalog = z.infer<typeof AnalysisCatalogSchema>

type Db = NodePgDatabase

const meta = (asOfWindowStart: number | null) => ({
  schemaVersion: ANALYSIS_SCHEMA_VERSION,
  generatedAt: Math.floor(Date.now() / 1000),
  asOfWindowStart,
  caveats: RESPONSE_CAVEATS,
})

export function analysisCatalog(): AnalysisCatalog {
  return AnalysisCatalogSchema.parse({
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    documentation: 'design/plays-analysis.md',
    capabilities: {
      tickerDossier: true,
      playAudit: true,
      directPgExport: true,
      outcomeMarks: false,
      correlationPrimitive: 'stored play evidence + finalized ticker dossier',
    },
    endpoints: [
      { method: 'GET', path: '/api/analysis', purpose: 'machine-readable capability catalog' },
      { method: 'GET', path: '/api/analysis/tickers/:ticker?from=<epoch>&to=<epoch>', purpose: 'finalized heat trajectory plus all published plays for one ticker' },
      { method: 'GET', path: '/api/analysis/plays/:id?beforeHours=72&afterHours=24', purpose: 'play extraction/interpretation audit plus nearby finalized heat' },
    ],
    cli: [
      'pnpm -C packages/worker analyze -- catalog',
      'pnpm -C packages/worker analyze -- ticker NVDA --from 2026-08-01 --to 2026-08-21',
      'pnpm -C packages/worker analyze -- play <reddit-id>',
      'pnpm -C packages/worker plays-export -- --from 2026-08-01 --to 2026-08-21 --range-basis anchor --format json',
    ],
    limits: {
      dossierRangeDays: MAX_DOSSIER_RANGE_SECONDS / 86_400,
      dossierPlays: MAX_DOSSIER_PLAYS,
      concurrentReads: MAX_ANALYSIS_CONCURRENCY,
      retryAfterSeconds: ANALYSIS_QUERY_TIMEOUT_SECONDS,
    },
    caveats: ANALYSIS_CAVEATS,
  })
}

interface HeatRead {
  asOfWindowStart: number | null
  rows: z.infer<typeof HeatPointSchema>[]
}

/** Read finalized rows only (`window_start < newest cycle`); exact missing-ticker windows remain null. */
async function readFinalizedHeat(
  db: Db,
  ticker: string,
  from: number,
  to: number,
): Promise<HeatRead> {
  const [latest] = await db.select({ ws: max(cycleRuns.windowStart) }).from(cycleRuns)
    .where(eq(cycleRuns.status, 'complete'))
  const newest = latest?.ws ?? null
  if (newest == null) return { asOfWindowStart: null, rows: [] }
  const [lastIncluded] = await db.select({ ws: max(cycleRuns.windowStart) }).from(cycleRuns)
    .where(and(
      eq(cycleRuns.status, 'complete'),
      gte(cycleRuns.windowStart, from),
      lt(cycleRuns.windowStart, Math.min(to, newest)),
    ))
  const asOfWindowStart = lastIncluded?.ws ?? null


  const rows = await db.select({
    windowStart: cycleRuns.windowStart,
    generatedAt: cycleRuns.generatedAt,
    totalMentions: cycleRuns.totalMentions,
    quiet: cycleRuns.quiet,
    capped: cycleRuns.capped,
    newestUtc: cycleRuns.newestUtc,
    mentions: empiricalFeatures.mentions,
    authors: empiricalFeatures.authors,
    sov: empiricalFeatures.sov,
    velocity: empiricalFeatures.velocity,
    accel: empiricalFeatures.accel,
    z: empiricalFeatures.z,
    netDir: empiricalFeatures.netDir,
    ddCount: empiricalFeatures.ddCount,
    baselineStatus: empiricalFeatures.baselineStatus,
    hE: empiricalFeatures.hE,
    hM: signals.hM,
    divergence: signals.divergence,
    quadrant: signals.quadrant,
    rank: signals.rank,
    rankDelta: signals.rankDelta,
    ret: analyticalFeatures.ret,
    rvol: analyticalFeatures.rvol,
    rvolConf: analyticalFeatures.rvolConf,
  }).from(cycleRuns)
    .leftJoin(empiricalFeatures, and(
      eq(empiricalFeatures.windowStart, cycleRuns.windowStart),
      eq(empiricalFeatures.ticker, ticker),
    ))
    .leftJoin(signals, and(
      eq(signals.windowStart, cycleRuns.windowStart),
      eq(signals.ticker, ticker),
    ))
    .leftJoin(analyticalFeatures, and(
      eq(analyticalFeatures.windowStart, cycleRuns.windowStart),
      eq(analyticalFeatures.ticker, ticker),
    ))
    .where(and(
      eq(cycleRuns.status, 'complete'),
      gte(cycleRuns.windowStart, from),
      lt(cycleRuns.windowStart, Math.min(to, newest)),
    ))
    .orderBy(asc(cycleRuns.windowStart))

  return { asOfWindowStart, rows: HeatPointSchema.array().parse(rows) }
}

const anchorText = sql`${playInterpretations.evidence}->>'anchor_utc'`
const evidenceAnchorExpr = sql<number | null>`case
  when (${anchorText}) ~ '^[0-9]{10}$' then case
    when (${anchorText})::bigint between ${ANALYSIS_MIN_EPOCH_SECONDS} and ${ANALYSIS_MAX_EPOCH_SECONDS}
      then (${anchorText})::float8 end
  end`
const anchorExpr = sql<number>`coalesce(${evidenceAnchorExpr}, ${plays.createdUtc}::float8)`

async function readDossierPlays(
  db: Db, ticker: string, from: number, to: number,
): Promise<{ rows: z.infer<typeof DossierPlaySchema>[]; truncated: boolean }> {
  const rows = await db.select({
    id: plays.id,
    createdUtc: plays.createdUtc,
    publishedAt: plays.publishedAt,
    author: plays.author,
    flair: plays.flair,
    title: plays.title,
    permalink: plays.permalink,
    category: plays.category,
    tags: plays.tags,
    confidence: plays.confidence,
    pnlAbs: plays.pnlAbs,
    pnlPct: plays.pnlPct,
    realized: plays.realized,
    summary: plays.summary,
    tldr: plays.tldr,
    extractorVersion: plays.extractorVersion,
    interpreterVersion: plays.interpreterVersion,
    taxonomyVersion: plays.taxonomyVersion,
    interpretationRunAt: playInterpretations.runAt,
    anchorUtc: anchorExpr,
    anchorBasis: sql<string | null>`case
      when (${evidenceAnchorExpr}) is not null
        then coalesce(nullif(${playInterpretations.evidence}->>'anchor_basis', ''), 'post_time')
      when ${plays.createdUtc} is not null then 'post_time'
      else null end`,
    evidence: playInterpretations.evidence,
  }).from(plays)
    .leftJoin(playInterpretations, and(
      eq(playInterpretations.playId, plays.id),
      eq(playInterpretations.runAt, plays.currentInterpretationAt),
    ))
    .where(and(
      eq(plays.status, 'published'),
      eq(plays.primaryTicker, ticker),
      sql`${anchorExpr} >= ${from}`,
      sql`${anchorExpr} < ${to}`,
    ))
    .orderBy(desc(anchorExpr), desc(plays.id))
    .limit(MAX_DOSSIER_PLAYS + 1)

  const parsed = rows.slice(0, MAX_DOSSIER_PLAYS).map((row) => DossierPlaySchema.parse({
    ...row,
    tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    anchorUtc: row.anchorUtc == null ? null : Math.trunc(Number(row.anchorUtc)),
    evidence: EvidenceSchema.parse(row.evidence),
  }))
  return { rows: parsed, truncated: rows.length > MAX_DOSSIER_PLAYS }
}

async function readCorpus(db: Db, from: number, to: number): Promise<{
  basis: 'createdUtc'
  byStatus: Array<{ status: string; count: number }>
  excludedGlobal: { unknownCreatedUtc: number }
}> {
  const rows = await db.select({ status: plays.status, count: sql<number>`count(*)::int` }).from(plays)
    .where(and(gte(plays.createdUtc, from), lt(plays.createdUtc, to)))
    .groupBy(plays.status)
    .orderBy(asc(plays.status))
  const [unknown] = await db.select({ count: sql<number>`count(*)::int` }).from(plays)
    .where(isNull(plays.createdUtc))
  return {
    basis: 'createdUtc',
    byStatus: rows.map((row) => ({ status: row.status, count: Number(row.count) })),
    excludedGlobal: { unknownCreatedUtc: Number(unknown?.count ?? 0) },
  }
}

/** Ticker facts in one snapshot. `range` selects play anchors and finalized radar window starts. */
export async function readTickerDossier(
  db: Db,
  ticker: string,
  range: { from: number; to: number },
): Promise<TickerDossier> {
  return db.transaction(async (tx) => {
    const snapshot = tx as unknown as Db
    const [nameRow] = await snapshot.select({ name: tickerNames.name }).from(tickerNames)
      .where(eq(tickerNames.symbol, ticker)).limit(1)
    // node-postgres serializes one transaction client; do not issue concurrent client.query calls
    // (deprecated in pg 8 and removed in pg 9).
    const heat = await readFinalizedHeat(snapshot, ticker, range.from, range.to)
    const relevant = await readDossierPlays(snapshot, ticker, range.from, range.to)
    const corpus = await readCorpus(snapshot, range.from, range.to)
    const known = nameRow != null
      || relevant.rows.length > 0
      || heat.rows.some((point) =>
        point.mentions != null || point.hE != null || point.hM != null || point.rank != null
        || point.ret != null || point.rvol != null,
      )
    return TickerDossierSchema.parse({
      meta: meta(heat.asOfWindowStart),
      range: { ...range, semantics: '[from,to)' },
      ticker: { symbol: ticker, name: nameRow?.name ?? null, known },
      heat: heat.rows,
      plays: relevant.rows,
      playsTruncated: relevant.truncated,
      corpus,
      outcomes: OUTCOME_TRACKING_CAPABILITY,
    })
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}

/** One play's served child runs plus nearby finalized heat, all from the same snapshot. */
export async function readPlayAudit(
  db: Db,
  id: string,
  query: PlayAuditQuery,
): Promise<PlayAudit | null> {
  return db.transaction(async (tx) => {
    const snapshot = tx as unknown as Db
    const detail = await readPlayDetail(snapshot, id)
    if (!detail) return null
    const evidence = detail.interpretation?.evidence
    const ticker = evidence?.ticker ?? detail.play.primaryTicker

    const evidenceAnchorUtc = evidence?.anchor_utc
    const anchorUtc = evidenceAnchorUtc ?? detail.play.createdUtc
    const anchorBasis = evidenceAnchorUtc != null
      ? (evidence?.anchor_basis ?? 'post_time')
      : (detail.play.createdUtc == null ? null : 'post_time')
    let heat: HeatRead = { asOfWindowStart: null, rows: [] }
    let range: { from: number; to: number; semantics: '[from,to)' } | null = null
    if (ticker != null && anchorUtc != null) {
      const anchorWindow = Math.floor(anchorUtc / WINDOW_SECONDS) * WINDOW_SECONDS
      const from = Math.max(0, anchorWindow - query.beforeHours * 3600)
      const to = anchorWindow + query.afterHours * 3600 + WINDOW_SECONDS
      heat = await readFinalizedHeat(snapshot, ticker, from, to)
      range = { from, to, semantics: '[from,to)' }
    }

    return PlayAuditSchema.parse({
      meta: meta(heat.asOfWindowStart),
      detail,
      context: { ticker, anchorUtc, anchorBasis, range, heat: heat.rows },
      outcomes: {
        status: OUTCOME_TRACKING_CAPABILITY.status,
        trackStatus: detail.play.trackStatus,
        marks: null,
      },
    })
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
