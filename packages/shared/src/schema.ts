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
  pgTable, text, integer, bigint, boolean, doublePrecision, jsonb, primaryKey, index, uniqueIndex,
} from 'drizzle-orm/pg-core'

/** BIGINT carried as a JS number (all values < 2^53). Epochs in seconds, and large counts (volume). */
const int8 = (name: string) => bigint(name, { mode: 'number' })

export const rawPosts = pgTable('raw_posts', {
  id: text('id').primaryKey(),
  createdUtc: int8('created_utc'),
  author: text('author'),
  title: text('title'),
  selftext: text('selftext'),
  removed: boolean('removed').notNull().default(false),
  linkFlairText: text('link_flair_text'),
  score: integer('score'),
  numComments: integer('num_comments'),
  retrievedOn: int8('retrieved_on'),
  source: text('source'),
}, (t) => [index('raw_posts_removed_idx').on(t.removed)])

export const rawComments = pgTable('raw_comments', {
  id: text('id').primaryKey(),
  createdUtc: int8('created_utc'),
  author: text('author'),
  linkId: text('link_id'),
  parentId: text('parent_id'),
  body: text('body'),
  removed: boolean('removed').notNull().default(false),
  score: integer('score'),
  retrievedOn: int8('retrieved_on'),
  source: text('source'),
}, (t) => [index('raw_comments_removed_idx').on(t.removed)])

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
  index('mentions_thing_type_id_idx').on(t.thingType, t.thingId),
])

/** One persisted source-kind poll attempt. Unlike `cycle_runs`, failed/stale attempts are retained so
 *  the board can distinguish upstream degradation from a dead worker immediately. */
export const ingestionRuns = pgTable('ingestion_runs', {
  source: text('source').notNull(),
  kind: text('kind').notNull(), // posts | comments
  pollTs: int8('poll_ts').notNull(),
  status: text('status').notNull(), // fresh | partial | capped | stale | no-data
  oldestUtc: int8('oldest_utc'),
  newestUtc: int8('newest_utc'),
  itemsFetched: integer('items_fetched').notNull(),
  pages: integer('pages').notNull(),
  capped: boolean('capped').notNull(),
  lagSeconds: integer('lag_seconds'),
}, (t) => [
  primaryKey({ columns: [t.source, t.kind, t.pollTs] }),
  index('ingestion_runs_kind_poll_idx').on(t.kind, t.pollTs),
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
  feed: text('feed'),
  asOf: int8('as_of'),
  retVolBaseline: doublePrecision('ret_vol_baseline'),
  volumeBaseline: doublePrecision('volume_baseline'),
  profileSessions: integer('profile_sessions'),
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
}, (t) => [
  primaryKey({ columns: [t.ticker, t.windowStart] }),
  // The web reads signals by window_start (the latest-window board); the composite PK can't serve that,
  // so mirror the empirical/analytical window indexes (M3 review).
  index('signals_window_start_idx').on(t.windowStart),
])

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

// --- WSB Plays (plays-plan §3) ----------------------------------------------------------------------
//
// Self-contained beside the radar's parity tables (which keep their exact shapes — plays-plan §1).
// Conventions: reddit ids are TEXT; every timestamp is bigint epoch SECONDS (the schema-wide int8
// convention — no timestamptz drift) EXCEPT `play_extractions`/`play_interpretations`.`run_at`, which is
// MILLISECONDS (a fast retry inside the same second must not be a unique-key insert error). No FKs —
// house style; the worker is the single writer and enforces referential order itself.

/**
 * One captured play (a flair-matched Gain/Loss/YOLO post) — also the QUEUE row that carries it through
 * `captured → media_ready → extracted → published` (off-ramps: `failed`, only after
 * `max_attempts`; `discarded`, the no-play tombstone — zero-position extraction or removed-post
 * purge — kept as a row so poll re-delivery can't re-insert and re-charge it, hidden from the
 * board). Insert is ON CONFLICT DO NOTHING and no writer ever moves `status` backwards
 * (invariant P8 — the 5-min poll re-delivers each post ~12×). Media state lives in `media_status`, NOT
 * `status`: a media failure degrades the play to text-only, it never parks or fails it (invariant P7).
 */
export const plays = pgTable('plays', {
  id: text('id').primaryKey(), // reddit post id
  createdUtc: int8('created_utc'),
  capturedAt: int8('captured_at'),
  publishedAt: int8('published_at'), // set by P3's denormalize+publish row update
  author: text('author'),
  flair: text('flair'),
  title: text('title'),
  selftext: text('selftext'),
  permalink: text('permalink'),
  url: text('url'),
  isGallery: boolean('is_gallery'),
  media: jsonb('media'), // PlayMediaItem[] — archived files (path relative to the media root, sha256, bytes)
  mediaStatus: text('media_status'), // pending | archived | failed | none (plays.ts)
  raw: jsonb('raw'), // the FULL Arctic-Shift dict — provenance + reprocessing input
  // Archive-time engagement is ~0/1 (Arctic ingests at creation); the P5 ≥48h refresh pass updates these
  // + `removed`, and stamps `refreshed_at` (without it "once per play" is unenforceable).
  score: integer('score'),
  numComments: integer('num_comments'),
  removed: boolean('removed'),
  refreshedAt: int8('refreshed_at'),
  // Queue fields. `claimed_at` is the lease: a claim older than `lease_minutes` is re-claimable, so a
  // crash mid-stage can't strand its rows as claimed-forever (plays-plan §3).
  status: text('status').notNull(), // captured | media_ready | extracted | published | failed | discarded
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: int8('next_attempt_at'),
  claimedAt: int8('claimed_at'),
  error: text('error'),
  // Transient-media-failure window: keep retrying the fetch until this passes, then degrade to text-only
  // (a single 429 at capture minute must not permanently strip a screenshot play — invariant P7).
  mediaRetryUntil: int8('media_retry_until'),
  // Current-run pointers — the detail page reads child rows BY THESE, never max(run_at), so a reprocess
  // that dies between child-insert and row-update can't mix v2 evidence with a v1 badge (plays-plan §5).
  currentExtractionAt: int8('current_extraction_at'),
  currentInterpretationAt: int8('current_interpretation_at'),
  // Denormalized board fields — filled by P3's publish update; NULL until then.
  primaryTicker: text('primary_ticker'),
  category: text('category'),
  tags: jsonb('tags'),
  confidence: doublePrecision('confidence'),
  pnlAbs: doublePrecision('pnl_abs'),
  pnlPct: doublePrecision('pnl_pct'),
  realized: boolean('realized'),
  summary: text('summary'),
  tldr: text('tldr'),
  extractorVersion: text('extractor_version'),
  interpreterVersion: text('interpreter_version'),
  taxonomyVersion: text('taxonomy_version'),
  // Outcome tracking (P5): open | expired | resolved-posted | untrackable.
  trackStatus: text('track_status'),
  trackUntil: int8('track_until'),
}, (t) => [
  index('plays_status_idx').on(t.status),
  index('plays_published_at_idx').on(t.publishedAt),
  index('plays_primary_ticker_idx').on(t.primaryTicker),
  index('plays_category_idx').on(t.category),
  index('plays_track_idx').on(t.trackStatus, t.trackUntil),
  index('plays_author_ticker_idx').on(t.author, t.primaryTicker), // P5 author-followup linker
])

/** One extraction run (P2). Unique (play_id, run_at-ms); every run is kept — cost audit + reprocess
 *  comparability. The play's `current_extraction_at` pointer selects the served run. */
export const playExtractions = pgTable('play_extractions', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  playId: text('play_id').notNull(),
  runAt: int8('run_at').notNull(), // MILLISECONDS (see convention note above)
  model: text('model'),
  promptVersion: text('prompt_version'),
  output: jsonb('output'),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  costUsd: doublePrecision('cost_usd'),
}, (t) => [uniqueIndex('play_extractions_play_run_idx').on(t.playId, t.runAt)])

/** One interpretation run (P3). `evidence` is the deterministically assembled radar+market block the
 *  prompt saw, stored verbatim — every published label is evidence-backed (invariant P2). */
export const playInterpretations = pgTable('play_interpretations', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  playId: text('play_id').notNull(),
  runAt: int8('run_at').notNull(), // MILLISECONDS
  model: text('model'),
  promptVersion: text('prompt_version'),
  evidence: jsonb('evidence'),
  output: jsonb('output'),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  costUsd: doublePrecision('cost_usd'),
}, (t) => [uniqueIndex('play_interpretations_play_run_idx').on(t.playId, t.runAt)])

/** Daily mark-to-market (P5) — per POSITION, not per play: a portfolio play holding shares AND options
 *  cannot carry one source/feed_conf, and partial closes would be invisible at play grain. Play-level
 *  P&L = sum over its positions. `ts` = the session date (epoch seconds). */
export const playMarks = pgTable('play_marks', {
  playId: text('play_id').notNull(),
  positionId: text('position_id').notNull(), // stable per-leg id from the extraction schema
  ts: int8('ts').notNull(),
  markValue: doublePrecision('mark_value'),
  pnlAbs: doublePrecision('pnl_abs'),
  pnlPct: doublePrecision('pnl_pct'),
  source: text('source'), // close | option_mark | intrinsic_floor | expiry_intrinsic
  feedConf: text('feed_conf'), // thin free IEX feed → low, like rvol_conf
  note: text('note'),
}, (t) => [primaryKey({ columns: [t.playId, t.positionId, t.ts] })])

/** Author-followup resolution links (P5): a later Gain/Loss post by the same author+ticker resolves an
 *  open play; both detail pages cross-reference. */
export const playLinks = pgTable('play_links', {
  playId: text('play_id').notNull(),
  resolutionPlayId: text('resolution_play_id').notNull(),
  kind: text('kind'), // author-followup
  linkedAt: int8('linked_at'),
}, (t) => [primaryKey({ columns: [t.playId, t.resolutionPlayId] })])

/**
 * Per-cycle publish marker (slice 3) — the v2 atomic-publish freshness record (v2-plan.md §5,
 * porting-spec §6). Beyond the v0.0.1 parity tables: the worker writes ONE row per published window
 * inside the SAME transaction as that window's features, so a row's existence == the cycle is complete
 * and durable. Readers take the latest complete window via `max(window_start)`; `quiet`/`capped` carry
 * the degraded-state flags the v0.0.1 snapshot used to expose.
 */
export const cycleRuns = pgTable('cycle_runs', {
  repairVersion: text('repair_version'),
  /** Last time a stable window's empirical+signal rows were rebuilt or verified under repairVersion. */
  repairedAt: int8('repaired_at'),
  windowStart: int8('window_start').primaryKey(),
  scoringVersion: text('scoring_version'),
  generatedAt: int8('generated_at'),
  /** Non-null only after the lateness horizon has moved past this window and dependent signals match
   *  the final empirical board. Publish-complete current snapshots deliberately remain null. */
  finalizedAt: int8('finalized_at'),
  totalMentions: integer('total_mentions'),
  quiet: boolean('quiet'),
  capped: boolean('capped'),
  newestUtc: int8('newest_utc'), // max across both kinds; compatibility/display convenience
  newestPostUtc: int8('newest_post_utc'),
  newestCommentUtc: int8('newest_comment_utc'),
  marketStatus: text('market_status'), // fresh | partial | preserved | unavailable | disabled
  marketRequested: integer('market_requested'),
  marketUsable: integer('market_usable'),
  marketAsOf: int8('market_as_of'), // oldest effective row as-of; conservative overlay vintage
  status: text('status'), // 'complete' = publish transaction committed, NOT longitudinally finalized
})
