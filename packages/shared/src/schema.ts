/**
 * Postgres schema — ported 1:1 from the frozen v0.0.1 `db.py SCHEMA` (architecture §2.7).
 *
 * Parity rules (v2-porting-spec.md §6):
 *  - Epoch + large-count columns are BIGINT. We use mode 'number' because every value is well under
 *    2^53 (epochs ~1.7e9; daily volume ~1e10) — keeps the integer floor-division window math identical.
 *    Reddit ids are TEXT, never numbers (no precision loss).
 *  - `flair_counts` was a JSON *string* in DuckDB → JSONB here (canonical, sorted-key object).
 *  - Composite PKs carry over exactly; per-table ON CONFLICT semantics live in the worker's upserts.
 *  - Plain B-tree indexes on the window/time read paths (sufficient at this volume).
 */
import {
  pgTable, text, integer, bigint, boolean, doublePrecision, jsonb, primaryKey, index,
} from 'drizzle-orm/pg-core'

/** BIGINT carried as a JS number (all values < 2^53). Epochs in seconds, and large counts (volume). */
const int8 = (name: string) => bigint(name, { mode: 'number' })

export const rawPosts = pgTable('raw_posts', {
  id: text('id').primaryKey(),
  createdUtc: int8('created_utc'),
  author: text('author'),
  title: text('title'),
  selftext: text('selftext'),
  linkFlairText: text('link_flair_text'),
  score: integer('score'),
  numComments: integer('num_comments'),
  retrievedOn: int8('retrieved_on'),
  source: text('source'),
})

export const rawComments = pgTable('raw_comments', {
  id: text('id').primaryKey(),
  createdUtc: int8('created_utc'),
  author: text('author'),
  linkId: text('link_id'),
  parentId: text('parent_id'),
  body: text('body'),
  score: integer('score'),
  retrievedOn: int8('retrieved_on'),
  source: text('source'),
})

export const mentions = pgTable('mentions', {
  ticker: text('ticker').notNull(),
  thingId: text('thing_id').notNull(),
  thingType: text('thing_type'),
  createdUtc: int8('created_utc'),
  author: text('author'),
  flair: text('flair'),
  direction: text('direction'),
}, (t) => [
  primaryKey({ columns: [t.ticker, t.thingId] }),
  index('mentions_created_utc_idx').on(t.createdUtc),
])

export const empiricalFeatures = pgTable('empirical_features', {
  ticker: text('ticker').notNull(),
  windowStart: int8('window_start').notNull(),
  mentions: integer('mentions'),
  authors: integer('authors'),
  sov: doublePrecision('sov'),
  velocity: doublePrecision('velocity'),
  accel: doublePrecision('accel'),
  z: doublePrecision('z'),
  netDir: doublePrecision('net_dir'),
  ddCount: integer('dd_count'),
  flairCounts: jsonb('flair_counts'), // DuckDB VARCHAR(JSON string) → JSONB
  baselineStatus: text('baseline_status'), // cold | warming | ready
  hE: doublePrecision('h_e'),
}, (t) => [
  primaryKey({ columns: [t.ticker, t.windowStart] }),
  index('empirical_features_window_start_idx').on(t.windowStart),
])

export const marketBars = pgTable('market_bars', {
  ticker: text('ticker').notNull(),
  ts: int8('ts').notNull(),
  o: doublePrecision('o'),
  h: doublePrecision('h'),
  l: doublePrecision('l'),
  c: doublePrecision('c'),
  volume: int8('volume'),
  vwap: doublePrecision('vwap'),
  feed: text('feed'),
  asOf: int8('as_of'),
}, (t) => [primaryKey({ columns: [t.ticker, t.ts] })])

export const optionsSnapshot = pgTable('options_snapshot', {
  ticker: text('ticker').notNull(),
  ts: int8('ts').notNull(),
  callVol: int8('call_vol'),
  putVol: int8('put_vol'),
  pcr: doublePrecision('pcr'),
  callOi: int8('call_oi'),
  putOi: int8('put_oi'),
  atmIv: doublePrecision('atm_iv'),
  ivRank: doublePrecision('iv_rank'),
  breadthStrikes: integer('breadth_strikes'),
  breadthExpiries: integer('breadth_expiries'),
  feed: text('feed'),
  asOf: int8('as_of'),
}, (t) => [primaryKey({ columns: [t.ticker, t.ts] })])

export const analyticalFeatures = pgTable('analytical_features', {
  ticker: text('ticker').notNull(),
  windowStart: int8('window_start').notNull(),
  ret: doublePrecision('ret'),
  rvol: doublePrecision('rvol'),
  rvolConf: text('rvol_conf'),
  pcr: doublePrecision('pcr'),
  ivRank: doublePrecision('iv_rank'),
  breadth: integer('breadth'),
  hM: doublePrecision('h_m'),
}, (t) => [
  primaryKey({ columns: [t.ticker, t.windowStart] }),
  index('analytical_features_window_start_idx').on(t.windowStart),
])

export const signals = pgTable('signals', {
  ticker: text('ticker').notNull(),
  windowStart: int8('window_start').notNull(),
  hE: doublePrecision('h_e'),
  hM: doublePrecision('h_m'),
  divergence: doublePrecision('divergence'),
  quadrant: text('quadrant'),
  rank: integer('rank'),
  rankDelta: integer('rank_delta'),
  leadLagHrs: doublePrecision('lead_lag_hrs'),
}, (t) => [primaryKey({ columns: [t.ticker, t.windowStart] })])

export const baselines = pgTable('baselines', {
  ticker: text('ticker').notNull(),
  how: integer('how').notNull(),
  mentionMean: doublePrecision('mention_mean'),
  mentionStd: doublePrecision('mention_std'),
  volMean: doublePrecision('vol_mean'),
}, (t) => [primaryKey({ columns: [t.ticker, t.how] })])

export const marketMovers = pgTable('market_movers', {
  ts: int8('ts').notNull(),
  kind: text('kind').notNull(), // active | gainer | loser
  rank: integer('rank').notNull(),
  symbol: text('symbol'),
  price: doublePrecision('price'),
  percentChange: doublePrecision('percent_change'),
  volume: int8('volume'),
}, (t) => [primaryKey({ columns: [t.ts, t.kind, t.rank] })])

export const tickerNames = pgTable('ticker_names', {
  symbol: text('symbol').primaryKey(),
  name: text('name'),
})

/**
 * Per-cycle publish marker (slice 3) — the v2 atomic-publish freshness record (v2-plan.md §5,
 * porting-spec §6). Beyond the v0.0.1 parity tables: the worker writes ONE row per published window
 * inside the SAME transaction as that window's features, so a row's existence == the cycle is complete
 * and durable. Readers take the latest complete window via `max(window_start)`; `quiet`/`capped` carry
 * the degraded-state flags the v0.0.1 snapshot used to expose.
 */
export const cycleRuns = pgTable('cycle_runs', {
  windowStart: int8('window_start').primaryKey(),
  generatedAt: int8('generated_at'),
  totalMentions: integer('total_mentions'),
  quiet: boolean('quiet'),
  capped: boolean('capped'),
  // `newest_utc` = the freshest source item seen this cycle. Persisted (not just logged) so a reader can
  // banner DATA staleness (now − newest_utc) distinctly from WORKER liveness (now − generated_at) — the
  // never-serve-stale requirement (v2-porting-spec.md §7). Null when the poll returned nothing.
  newestUtc: int8('newest_utc'),
  status: text('status'), // 'complete' (forward-compat; a row already implies complete)
})
