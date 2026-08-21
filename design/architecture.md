# Architecture (v0.0.1)

> The system that turns the [signal framework](./signal-framework.md) into a running near-live
> radar. **Stack:** Reddit via the **Arctic-Shift + PullPush** taps (no Reddit API —
> [`../sources/reddit-data-access.md`](../sources/reddit-data-access.md)); market data behind a
> pluggable **`MarketData` funnel**, **settled on Alpaca** for v0.0.1 (Massive / IBKR swappable)
> ([`../sources/market-data-access.md`](../sources/market-data-access.md)).

## 0. What "live" realistically means here

Two lags bound the product; both are acceptable for a *trending* radar, but be honest:
- **Reddit side:** Arctic-Shift content latency **verified ~seconds–minutes** (2026-06-03 probe) +
  **no live engagement** (upvotes settle after ~36 h → mention-based ranking). **PullPush is frozen
  @2025-05-19** → not a live fallback (single-source risk).
- **Market side:** the only **free** intraday feed is **Alpaca real-time IEX** (+ indicative
  options w/ Greeks/IV). IEX is ~2.5% of volume → **`rvol` is low-confidence until a paid SIP
  feed**. (Massive's free tier is **EOD-only**.)

⇒ **WSB Signals polls every ~5 min**; with free-tier delayed options the effective market-data
freshness is ~5–15 min, and volume signals firm up once on a paid SIP feed. That granularity fits
"what is WSB piling into right now."

## 1. Data flow

```
                    ┌────────────────────────────────────────────────┐
  Arctic-Shift ───► │                 SOURCES (taps)                  │
   (PRIMARY)        │  poll /search (new posts + Daily-thread comments)│
                    │  + /aggregate + /time_series  (denominators)    │
  PullPush (down)   │  (PullPush frozen @2025-05-19 → old history only)│
   ⛔ frozen        │  [ Discord — deferred, behind Source interface ]│
                    └───────────────────┬────────────────────────────┘
                                        │ raw posts / comments
                                        ▼
                    ┌────────────────────────────────────────────────┐
                    │              PROCESSING (Python)                │
                    │  1. Ticker extractor  (whitelist + stoplist)    │
                    │  2. Classifier  (flair · direction · conviction)│
                    │  3. Windowed aggregator → EMPIRICAL features    │
                    │     mentions·authors·sov·z·velocity·accel·net_dir│
                    │     → H_e  (live WSB Heat)                       │
                    └───────────────────┬────────────────────────────┘
                                        │ hot leaderboard (top-N by H_e)
                                        ▼
  MarketData ─────► ┌────────────────────────────────────────────────┐
   funnel           │      MARKET DATA  (gated by hot leaderboard)    │
  (Alpaca free /    │  stocks : snapshots (price/vol — IEX on free)   │
   Massive paid)    │  options: chain snapshot (Greeks·IV), top-N     │
   SPY/QQQ context  │  → ret · rvol* · pcr · iv · breadth → H_m       │
                    └───────────────────┬────────────────────────────┘
                                        ▼   (* rvol low-confidence on thin free-IEX volume)
                    ┌────────────────────────────────────────────────┐
                    │   SIGNALS   H_e × H_m → divergence · quadrant   │
                    │             lead-lag · alerts                   │
                    └───────────────────┬────────────────────────────┘
                                        ▼
        Storage: DuckDB + Parquet   │   Output: leaderboard · JSON · (later) dashboard
```

## 2. Components

### 2.1 Sources (ingestion) — behind one `Source` interface
`Source` = `{ poll(window), backfill(range), search(query), stream() }`. Implementations:
- **`ArcticShiftSource` (primary):** poll `/api/posts/search` + `/api/comments/search` for
  `subreddit=wallstreetbets` (every 5 min, `limit=auto`); pull the **Daily Discussion Thread**
  comments (the firehose); `/aggregate` for cheap count series, `/time_series` for the activity
  denominator. Backfill via the download-tool dump.
- **`PullPushSource` (dormant):** ⛔ ingestion **frozen @2025-05-19** (verified 2026-06-03) — not a
  live fallback. Keep for old-history / Reddit-wide-FTS only; re-test before relying.
- **`DiscordSource` (deferred):** interface only in v0.0.1
  ([`../sources/wallstreetbets.md` §9](../sources/wallstreetbets.md)).

> **Decided (2026-06-03): thin in-house `httpx` client.** Only Arctic-Shift is live (PullPush
> frozen), so [BAScraper](https://github.com/maxjo020418/BAScraper)'s dual-tap value is largely
> moot, and the e2e PoC already proves a stdlib pull. BAScraper stays an **optional fallback** if
> rate-limit/retry handling gets fiddly.

### 2.2 Ticker extractor
- Candidate regex `\$?[A-Z]{2,5}` (bare 1-char tokens only via an explicit `$`-cashtag) over
  title + selftext + comment body. (The e2e PoC uses `{2,5}` — keep the doc and code in sync.)
- **Validate** against a symbol **whitelist** (Alpaca `assets` / Massive `reference/tickers`;
  refresh weekly) **minus** a WSB **stoplist** (`CEO, YOLO, FD, IMO, DD, WSB, USA, IT, A, ATH,
  EOD, …`).
- **Precision boosts are day-one, not "later":** `$`-cashtags = high confidence; co-occurrence
  with trading words (`calls/puts/strike/$/expiry/C/P`) up-weights ambiguous tokens. The extractor
  is the foundation of every empirical signal — **measure its precision/recall on a labelled WSB
  sample** before trusting the leaderboard, and re-check as slang drifts.
- Drop bot authors here (`wsbapp, AutoModerator, VisualMod, …`).
- Output: `mentions` rows `(thing_id, thing_type, ticker, created_utc, author, flair, direction)`.

### 2.3 Classifier
- **Flair** (primary, high-integrity label) → DD/YOLO/Gain/Loss/News/Discussion.
- **Direction:** keyword polarity over options/position language → `bull`/`bear`/`neutral`.
- **Conviction:** `dd_count`; `yolo_usd` from text now, images later (OCR/vision **stub**).
- **Sentiment:** WSB-tuned lexicon (weak feature); LLM stance on a sampled subset later (**stub**).

### 2.4 Windowed aggregator
Rolls `mentions` into `(ticker, window)` cells (1 h primary; 15 min intraday). Computes empirical
features + **`H_e`** ([signal-framework §2–§5](./signal-framework.md)), **ranking on `sov` with
`z` gated on baseline readiness** (signal-framework §4). Maintains per-ticker hour-of-week
**baselines** for `z` with a `baseline_status` (cold/warming/ready), **warmed forward-only for
v0.0.1** (no backfill; seeding via dumps to accelerate `z` is a Phase-4 option —
[reddit-data-access §5](../sources/reddit-data-access.md)).

### 2.5 Market-data funnel (pluggable: Alpaca / Massive)
Market data sits behind the **`MarketData`** interface
([`../sources/market-data-access.md`](../sources/market-data-access.md)). **Free-tier reality
drives the v0.0.1 choice:**
- **Default impl = `AlpacaMarketData` (free).** Only free tier that does **intraday**: real-time
  **IEX** stock snapshots (`/v2/stocks/snapshots`) + **indicative option chains with Greeks/IV**
  (`/v1beta1/options/snapshots/{underlying}`), **200 calls/min**, WebSocket (1-connection limit).
- **Alt impl = `MassiveMarketData` (paid).** At Starter+ ($29/asset) unlocks the **full-market
  snapshot** (1 req → all tickers), gainers/losers, and **real-time option Greeks/IV** — route
  these here when you pay. Free Massive is EOD-only (don't use for intraday).
- **Alt impl = `IBKRMarketData` (account-based).** Institutional real-time **full-volume** prices
  + complete option chains via the Client Portal Web API, if you run an **IBKR Pro** account with
  data subscriptions; wired through **ibind**/**ibeam**. Highest fidelity, heaviest integration —
  the watchlist/conid model fits hot-list gating
  ([`../sources/ibkr.md`](../sources/ibkr.md)).
- **Options gating:** fetch chains only for the **top-N hot leaderboard** by `H_e`.
- **Current v2 stock overlay:** fetch top-N snapshots plus cached trailing daily profiles. `H_m`
  combines volatility-scaled day return and session-adjusted volume pace on fixed per-ticker scales;
  it is never rescaled by the other current hot tickers. Latest-trade/minute-bar timestamps carry the
  true market as-of; un-timestamped evidence cannot produce `H_m`.
- **Market-wide screeners:** capture most-actives/movers separately. The web filters to named assets
  with price/volume floors and labels the panel market-wide context; rows do not automatically become
  STEALTH signals.
- **Indices/VIX:** Alpaca has no index feed → SPY/QQQ ETF proxies for context; VIX needs Massive.
- ⚠️ **`rvol` confidence:** low on free IEX/EOD volume; reliable only on a paid SIP feed.

### 2.6 Signal engine
Joins empirical + analytical `(T, W)` cells → `H_m`, `divergence = H_e − H_m`, **quadrant**
(Confirmed / Hype / Stealth / Quiet), rolling **lead-lag**, alert triggers
([signal-framework §6, §8](./signal-framework.md)).

### 2.7 Storage model (v0.0.1 origin; v2 realized in Postgres)
The logical tables originated in the embedded v0.0.1 design; v2 realizes them in Postgres/Drizzle
with atomic per-window publish and explicit longitudinal finalization.

| Table | Grain | Key columns |
|---|---|---|
| `raw_posts` | post | `id, created_utc, author, title, selftext, removed, link_flair_text, score, num_comments, retrieved_on, source` |
| `raw_comments` | comment | `id, created_utc, author, link_id, parent_id, body, removed, score, source` |
| `mentions` | (ticker × thing) | `ticker, thing_id, thing_type, created_utc, author, flair, direction` |
| `ingestion_runs` | (source × kind × poll) | `status, oldest/newest_utc, items, pages, capped, lag_seconds` |
| `empirical_features` | (ticker × window) | `ticker, window_start, mentions, authors, sov, velocity, accel, z, net_dir, dd_count, flair_counts, H_e` |
| `market_bars` | (ticker × bar) | `ticker, ts, o,h,l,c, volume, vwap, feed, as_of` |
| `options_snapshot` | (ticker × snap) | `ticker, ts, call_vol, put_vol, pcr, call_oi, put_oi, atm_iv, iv_rank, breadth_strikes, breadth_expiries, feed, as_of` |
| `analytical_features` | (ticker × window) | `ret, rvol, rvol_conf, feed, as_of, ret_vol_baseline, volume_baseline, profile_sessions, H_m` |
| `signals` | (ticker × window) | `ticker, window_start, H_e, H_m, divergence, quadrant, rank, rank_delta, lead_lag_hrs` |
| `cycle_runs` | window | `scoring/repair_version, generated/finalized/repaired_at, per-kind freshness, market coverage/as_of, status` |
| `market_movers` | (screener row) | `ts, kind, rank, symbol, price, percent_change, volume` |
| `ticker_names` | symbol | `symbol, name` |

(`feed`/`as_of` columns carry data-provenance; `rvol_conf` flags thin-feed low confidence.)

### 2.8 Output (the radar)
- Nuxt SSR board: provisional current-window board, explicit source/market quality states, compact
  mobile cards, separate market-wide context, and per-ticker finalized seven-day heat history.
- Agent/operator tooling: bounded analysis API plus labeled extraction and finalized-window calibration
  CLIs.

## 3. Scheduling & cadence

| Job | Cadence | Notes |
|---|---|---|
| Arctic-Shift poll (posts + Daily-thread comments) | **5 min** | `limit=auto`; back off on `X-RateLimit-Remaining`. |
| Empirical aggregation + `H_e` | each poll cycle | recompute current windows + leaderboard. |
| Stock snapshots (funnel) | **5 min** | Alpaca multi-symbol snapshot (free, 200/min) or Massive full-market snapshot (paid). |
| Options chain (hot-list) | top-N by `H_e` | Alpaca chain snapshot (200/min ample) or Massive per-underlying (paid). |
| Signal join + quadrant + alerts | each cycle | |
| Engagement reconciliation (>36 h) | hourly/daily | re-fetch `score`/`num_comments` from Arctic-Shift. |
| Baseline refresh | daily | rolling hour-of-week stats. |
| **Source freshness heartbeat** | each poll cycle | newest-item lag vs wall-clock; **alarm if it exceeds a threshold** — Arctic-Shift is the sole live tap (no SLA), so degradation must page, not pass silently. |

Runner: a single async loop (`asyncio` + `httpx`) or `APScheduler`. No distributed infra for
v0.0.1.

> **Throughput caveat:** the Daily Discussion Thread emits thousands of comments/hour at peak.
> Confirm a 5-min paginated poll actually captures the full window within rate limits (a
> Phase-0 spike) — incomplete ingestion silently biases both `sov` denominators and per-post
> comment counts. The PoC's `[CAP]` warning is the canary.

## 4. Tech stack (recommended)

| Concern | Choice | Rationale |
|---|---|---|
| Language | **Python ≥3.10** | Arctic-Shift tooling needs 3.10+; best NLP/data ecosystem. |
| Reddit ingestion | **thin in-house `httpx`** (BAScraper optional fallback) | Only one tap (Arctic-Shift) to wrap; the e2e PoC already proves it; full control of pagination/rate-limit/dedup. |
| Market-data client | **Alpaca SDK** / **`massive`** / **ibind** (IBKR) | Behind the `MarketData` funnel; mix & match. |
| Validation | `pydantic` | Typed records from messy JSON. |
| Store / analytics | **DuckDB** + Parquet | Embedded columnar; fast window aggregation; no server. |
| Dataframes | `polars` or `pandas` | Windowing, z-scores, rvol. |
| Scheduling | `asyncio` loop / `APScheduler` | Lightweight. |
| NLP | regex + symbol list + `vaderSentiment` (WSB-tuned) | Cheap baseline; LLM stance later. |
| Dashboard (**v0.0.1**) | `Streamlit` | Minimal board now; per-ticker drill-down in v0.0.2. |
| Config | `.env` + `config.toml` | Tunable signal weights, thresholds, API keys (**never** committed). |

> Optional: both providers ship **MCP servers** (Alpaca `alpaca-mcp-server`; Massive
> `mcp_massive`) — handy for ad-hoc agent-driven "what's moving" queries during development, but
> the pipeline should call the REST/WS APIs directly.

## 5. Non-negotiables (carry from the framework)
- **Rank on `sov`, not raw counts or cold-start `z`** — `z` enters only when its baseline is
  `ready` ([signal-framework §4](./signal-framework.md)).
- **Deterministic, canonical ranking** — board order and SoV ranks break ties by an explicit total
  order (`H_e → sov → authors → mentions → ticker`), never by DB row or dict-insertion order, so the
  board is reproducible run-to-run and well-defined for any re-implementation.
- **Flair-segment** empirical signals.
- **Badge divergence, don't predict** — quadrants require timestamped market evidence, sufficient
  rolling population, and per-row author support. Market-wide screeners remain separate context.
- **Monitor source freshness per content kind** — posts and comments both feed SoV; either partial,
  stale, or empty kind invalidates scoring and is persisted for immediate board diagnosis.
- **A `capped` (pagination-truncated) window is low-trust** — its `sov` is undercounted
  ([data-model](./data-model.md) invariant 14); surface it to the board.
- **Missing market evidence is `null`, never zero;** preserve feed/as-of/profile support.
- **Flag `rvol` confidence by feed**; don't treat free-IEX volume as ground truth.
- **Outcome/P&L is per-post only — never aggregate to a per-ticker win rate** (survivorship).
- **Never commit API keys** (Alpaca, Massive).
