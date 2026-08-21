/**
 * The board read (slice 8). Assembles the latest COMPLETE cycle for the web, honoring the v2 read
 * contract (porting-spec §6/§11):
 *
 *  - **Latest complete window** — `cycle_runs WHERE status='complete' ORDER BY window_start DESC LIMIT 1`
 *    (mirrors `packages/worker/src/db.ts:213 latestCompleteWindow`). A row's existence guarantees the
 *    window's features/signals committed atomically — never a half-written cycle.
 *  - **One read-only REPEATABLE READ transaction** for ALL reads, so the four queries observe a SINGLE
 *    snapshot. The worker re-publishes the same `window_start` every cycle (12×/hour); without this a
 *    multi-query read could straddle a republish and return a torn board (review-gate HIGH finding).
 *  - **H_m / divergence / quadrant come from `signals`** (publish-time effective values) — NOT from
 *    `analytical_features`, which is absent on a new-window market-fetch failure. `analytical_features`
 *    supplies only `ret`/`rvol` (day-to-date; may be null, or a within-window-preserved prior value).
 *  - **LEFT JOINs off an `empirical_features` base** — every board ticker has an empirical row; signals/
 *    analytical/ticker_names are optional, so non-overlaid tickers and market-outage cycles never drop or
 *    blank the board.
 *  - **Sorted in JS** with the canonical `compareBoard` from `@wsb/shared` (one definition shared with the
 *    worker) — nullable sort keys coalesced to 0, avoiding SQL `NULLS FIRST`/collation drift.
 */
import {
  analyticalFeatures, compareBoard, cycleRuns, empiricalFeatures, ingestionRuns, marketMovers,
  MIN_MARKET_CONTEXT_PRICE, MIN_MARKET_CONTEXT_VOLUME, prettyName, signals, tickerNames,
} from '@wsb/shared'
import { and, asc, desc, eq, max } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

export interface RawBoardRow {
  rank: number
  ticker: string
  name: string
  mentions: number | null
  authors: number | null
  sov: number | null
  velocity: number | null
  accel: number | null
  z: number | null
  netDir: number | null
  ddCount: number | null
  baselineStatus: string | null
  hE: number | null
  hM: number | null
  divergence: number | null
  quadrant: string | null
  rankDelta: number | null
  ret: number | null
  rvol: number | null
  rvolConf: string | null
  marketFeed: string | null
  retVolBaseline: number | null
  volumeBaseline: number | null
  profileSessions: number | null
  marketAsOf: number | null
}

export interface RawMover {
  kind: string
  rank: number
  symbol: string | null
  name: string
  price: number | null
  percentChange: number | null
  volume: number | null
  ts: number
}

export interface RawWindow {
  start: number
  scoringVersion: string | null
  generatedAt: number | null
  finalizedAt: number | null
  totalMentions: number | null
  quiet: boolean | null
  capped: boolean | null
  newestUtc: number | null
  newestPostUtc: number | null
  newestCommentUtc: number | null
  marketStatus: string | null
  marketRequested: number | null
  marketUsable: number | null
  marketAsOf: number | null
}

export interface RawSourceRun {
  source: string
  status: string
  pollTs: number
  newestUtc: number | null
  lagSeconds: number | null
  itemsFetched: number
  capped: boolean
}

export interface RawBoard {
  state: 'ok' | 'empty' | 'no-data'
  window: RawWindow | null
  source: { posts: RawSourceRun | null; comments: RawSourceRun | null }
  rows: RawBoardRow[]
  movers: RawMover[]
}

/** Read the latest complete board. `db` is injected (handler passes `useDb()`; the IT passes a test
 *  handle) so this stays Nitro-independent and integration-testable. */
export async function readBoard(db: NodePgDatabase): Promise<RawBoard> {
  return db.transaction<RawBoard>(async (tx) => {
    const latestSource = async (kind: 'posts' | 'comments'): Promise<RawSourceRun | null> => {
      const [r] = await tx.select({
        source: ingestionRuns.source,
        status: ingestionRuns.status,
        pollTs: ingestionRuns.pollTs,
        newestUtc: ingestionRuns.newestUtc,
        lagSeconds: ingestionRuns.lagSeconds,
        itemsFetched: ingestionRuns.itemsFetched,
        capped: ingestionRuns.capped,
      }).from(ingestionRuns)
        .where(eq(ingestionRuns.kind, kind))
        .orderBy(desc(ingestionRuns.pollTs))
        .limit(1)
      return r ?? null
    }
    const source = {
      posts: await latestSource('posts'),
      comments: await latestSource('comments'),
    }

    // Latest publish-complete snapshot. `finalizedAt` is a separate longitudinal-read gate.
    const [w] = await tx.select({ ws: cycleRuns.windowStart })
      .from(cycleRuns)
      .where(eq(cycleRuns.status, 'complete'))
      .orderBy(desc(cycleRuns.windowStart))
      .limit(1)
    if (!w) return { state: 'no-data', window: null, source, rows: [], movers: [] }
    const windowStart = w.ws

    const [cycle] = await tx.select({
      scoringVersion: cycleRuns.scoringVersion,
      generatedAt: cycleRuns.generatedAt,
      finalizedAt: cycleRuns.finalizedAt,
      totalMentions: cycleRuns.totalMentions,
      quiet: cycleRuns.quiet,
      capped: cycleRuns.capped,
      newestUtc: cycleRuns.newestUtc,
      newestPostUtc: cycleRuns.newestPostUtc,
      newestCommentUtc: cycleRuns.newestCommentUtc,
      marketStatus: cycleRuns.marketStatus,
      marketRequested: cycleRuns.marketRequested,
      marketUsable: cycleRuns.marketUsable,
      marketAsOf: cycleRuns.marketAsOf,
    }).from(cycleRuns).where(eq(cycleRuns.windowStart, windowStart)).limit(1)
    const windowMeta: RawWindow = {
      start: windowStart,
      scoringVersion: cycle?.scoringVersion ?? null,
      generatedAt: cycle?.generatedAt ?? null,
      finalizedAt: cycle?.finalizedAt ?? null,
      totalMentions: cycle?.totalMentions ?? null,
      quiet: cycle?.quiet ?? null,
      capped: cycle?.capped ?? null,
      newestUtc: cycle?.newestUtc ?? null,
      newestPostUtc: cycle?.newestPostUtc ?? null,
      newestCommentUtc: cycle?.newestCommentUtc ?? null,
      marketStatus: cycle?.marketStatus ?? null,
      marketRequested: cycle?.marketRequested ?? null,
      marketUsable: cycle?.marketUsable ?? null,
      marketAsOf: cycle?.marketAsOf ?? null,
    }

    // 3. board: empirical base LEFT JOIN signals/analytical/ticker_names
    const joined = await tx.select({
      ticker: empiricalFeatures.ticker,
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
      sigHm: signals.hM,
      divergence: signals.divergence,
      quadrant: signals.quadrant,
      rankDelta: signals.rankDelta,
      ret: analyticalFeatures.ret,
      rvol: analyticalFeatures.rvol,
      retVolBaseline: analyticalFeatures.retVolBaseline,
      volumeBaseline: analyticalFeatures.volumeBaseline,
      profileSessions: analyticalFeatures.profileSessions,
      rvolConf: analyticalFeatures.rvolConf,
      marketFeed: analyticalFeatures.feed,
      marketAsOf: analyticalFeatures.asOf,
      name: tickerNames.name,
    })
      .from(empiricalFeatures)
      .leftJoin(signals, and(
        eq(signals.ticker, empiricalFeatures.ticker),
        eq(signals.windowStart, empiricalFeatures.windowStart),
      ))
      .leftJoin(analyticalFeatures, and(
        eq(analyticalFeatures.ticker, empiricalFeatures.ticker),
        eq(analyticalFeatures.windowStart, empiricalFeatures.windowStart),
      ))
      .leftJoin(tickerNames, eq(tickerNames.symbol, empiricalFeatures.ticker))
      .where(eq(empiricalFeatures.windowStart, windowStart))

    const sorted = [...joined].sort((a, b) => compareBoard(
      { hE: a.hE ?? 0, sov: a.sov ?? 0, authors: a.authors ?? 0, mentions: a.mentions ?? 0, ticker: a.ticker },
      { hE: b.hE ?? 0, sov: b.sov ?? 0, authors: b.authors ?? 0, mentions: b.mentions ?? 0, ticker: b.ticker },
    ))
    const rows: RawBoardRow[] = sorted.map((r, i) => ({
      rank: i + 1,
      ticker: r.ticker,
      name: prettyName(r.name),
      mentions: r.mentions,
      authors: r.authors,
      sov: r.sov,
      velocity: r.velocity,
      accel: r.accel,
      z: r.z,
      netDir: r.netDir,
      ddCount: r.ddCount,
      baselineStatus: r.baselineStatus,
      hE: r.hE,
      hM: r.sigHm, // effective H_m from signals (NOT analytical) — see header
      divergence: r.divergence,
      quadrant: r.quadrant,
      rankDelta: r.rankDelta,
      ret: r.ret,
      rvol: r.rvol,
      rvolConf: r.rvolConf,
      marketFeed: r.marketFeed,
      retVolBaseline: r.retVolBaseline,
      volumeBaseline: r.volumeBaseline,
      profileSessions: r.profileSessions,
      marketAsOf: r.marketAsOf,
    }))

    // 4. Separate market-wide context. Every row must be named and clear both the price and liquidity
    // floors; unfiltered screener rows are never implied to be WSB-native STEALTH candidates.
    const [mx] = await tx.select({ ts: max(marketMovers.ts) }).from(marketMovers)
    let movers: RawMover[] = []
    if (mx?.ts != null) {
      const moverRows = await tx.select({
        kind: marketMovers.kind,
        rank: marketMovers.rank,
        symbol: marketMovers.symbol,
        price: marketMovers.price,
        percentChange: marketMovers.percentChange,
        volume: marketMovers.volume,
        ts: marketMovers.ts,
        name: tickerNames.name,
      })
        .from(marketMovers)
        .leftJoin(tickerNames, eq(tickerNames.symbol, marketMovers.symbol))
        .where(eq(marketMovers.ts, mx.ts))
        .orderBy(asc(marketMovers.kind), asc(marketMovers.rank))
      movers = moverRows
        .filter((m) =>
          m.name != null
          && (m.price ?? 0) >= MIN_MARKET_CONTEXT_PRICE
          && (m.volume ?? 0) >= MIN_MARKET_CONTEXT_VOLUME,
        )
        .map((m) => ({
          kind: m.kind,
          rank: m.rank,
          symbol: m.symbol,
          name: prettyName(m.name),
          price: m.price,
          percentChange: m.percentChange,
          volume: m.volume,
          ts: m.ts,
        }))
    }

    return { state: rows.length ? 'ok' : 'empty', window: windowMeta, source, rows, movers }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
