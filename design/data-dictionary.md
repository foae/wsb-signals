# Data Dictionary (canonical field reference)

> The **rock-solid, complete, storage-agnostic definition of every field** in WSB Signals — across all
> entities, published and unpublished, live and planned. Each field is defined *what it is*, *how it is
> computed*, its *logical type & domain*, what *`null` means*, its *lifecycle/publication status*, the
> *source* it derives from, and how a high vs low value reads.
>
> - Structure, keys, relationships, and storage realization: [`data-model.md`](./data-model.md).
> - *What can be inferred from where* + per-signal degradation: [`signals-catalog.md`](./signals-catalog.md).
> - Machine-readable contract: [`schema/`](./schema/). Conceptual rationale: [`signal-framework.md`](./signal-framework.md).
>
> **Physical types are out of scope** — every type below is logical (see the
> [type vocabulary](./data-model.md#3-logical-type-vocabulary)). `null` **never means zero**: a measured
> 0 is a value; `null` means "could not be computed this cell".

## How to read the tables

**Type** — from the logical vocabulary: `Symbol Id Text Enum Count Real UnitInterval [0,1] SignedUnit [−1,1] Ratio ≥0 Money Instant Duration SeasonalBucket Map Boolean`.

**Status** — lifecycle + publication, combined:

| Token | Meaning |
|---|---|
| `live✓` | Computed, stored, **and surfaced** in the dashboard / JSON snapshot today. |
| `live·` | Computed and stored today, but **not surfaced** (internal). |
| `txn` | Computed **transiently** during aggregation today, **not persisted** — the canonical model persists it. |
| `def` | A schema column **exists** today but is **not populated** (defined-unwritten). |
| `P2`/`P3`/`P4` | **Planned**: Phase-2 options increment / Phase-3 signals / Phase-4 enrichment. |

**Src** — originating source: `R` Reddit · `D` Discord · `R/D` either community source · `stk` stock-market feed · `opt` options feed · `calc` derived from other fields · `ref` static reference · `meta` provenance/bookkeeping. Full degradation behaviour per signal is in [`signals-catalog.md`](./signals-catalog.md).

---

## 1. Reference dimensions

### 1.1 `instrument` — the tradable universe (`ref`)
| Field | Type | Domain | Null = | Status | Definition · notes |
|---|---|---|---|---|---|
| `symbol` | Symbol | uppercase ticker | — | live✓ | The stock/ETF symbol. Natural key. Every `mention.ticker` must exist here (extractor validates against the whitelist). |
| `name` | Text | — | unknown | live✓ | Raw vendor (UPPERCASE) company/fund name, e.g. `BROADCOM INC. COMMON STOCK`. The display layer prettifies it (`pretty_name` → `Broadcom Inc.`). |
| `asset_class` | Enum | `equity`/`etf`/… | unknown | P4 | Security class; lets ETFs/leveraged products be treated differently (e.g. liquidity filters for STEALTH). |
| `is_etf` | Boolean | — | unknown | P4 | True for funds; used to down-weight leveraged-ETF screener noise. |
| `is_ambiguous` | Boolean | — | `false` | live· | A real ticker that is also a common English word (e.g. `DRAM`, `IT`, `ON`). When true, a bare mention is counted **only with trading context** (an options/position word or a `$`-cashtag). Currently a gitignored file (`whitelist/ambiguous.txt`); promote into this dimension. |
| `listing_status` | Enum | `active`/`delisted`/… | unknown | P4 | Tradability state; refreshed weekly from the vendor asset list. |
| `first_seen` / `last_refreshed` | Instant | UTC | — | P4 | Universe bookkeeping (when the symbol entered / was last reconciled). |

### 1.2 `author` — community account *(Phase 4)* (`R/D`)
| Field | Type | Domain | Null = | Status | Definition · notes |
|---|---|---|---|---|---|
| `username` | Id | — | — | P4 | Account handle. Natural key. Today authors are bare strings on events. |
| `account_created` | Instant | UTC | unknown | P4 | Account age basis for `author_cred`/`astroturf`. Reddit via Arctic-Shift user data; Discord via join date. |
| `karma` | Count | ≥0 | unknown | P4 | Reddit karma (Discord has no analog → `null`). |
| `author_cred` | UnitInterval | [0,1] | not yet computed | P4 | Tenure/karma-derived credibility weight. Down-weights brand-new accounts. 0 = untrusted, 1 = established. |
| `is_bot` | Boolean | — | `false` | live· | Known bot/automation (`AutoModerator`, `VisualMod`, `wsbapp`, …). Filtered at ingestion (config list today). |
| `first_seen` / `last_seen` | Instant | UTC | — | P4 | Activity span bookkeeping. |

---

## 2. Raw community content

### 2.1 `content_item` — post / comment / message (`R/D`)
Generalized across platforms; field applicability per `(platform, kind)` is in
[data-model §5.2](./data-model.md#52-raw-event-streams-append-only-source-of-truth).

| Field | Type | Domain | Null = | Status | Src | Definition · notes |
|---|---|---|---|---|---|---|
| `platform` | Enum `Platform` | `reddit`/`discord` | — | live· | R/D | Which community source produced the item. Reddit-only today. Drives field applicability + which signals are computable. |
| `kind` | Enum `ContentKind` | `post`/`comment`/`message` | — | live· | R/D | `post`/`comment` = Reddit; `message` = Discord. |
| `id` | Id | platform-native id | — | live· | R/D | E.g. Reddit `t3_…`/`t1_…`. Natural key with `platform`. |
| `created_utc` | Instant | UTC | — | live· | R/D | **Event time** — when the item was authored. The clock all empirical windows align to. |
| `author` | Id | — | deleted/unknown | live· | R/D | Author handle (→ `author` dim). Bots filtered at ingestion. |
| `container` | Text | — | — | live· | R/D | Topical bucket: **subreddit** (Reddit) or **channel** (Discord). On Discord this is a segmentation/conviction signal (a ticker-specific or #options channel). |
| `root_id` / `parent_id` | Id | — | none/root | live· | R/D | Thread tree: submission/thread root and immediate parent. |
| `title` | Text | — | n/a (comments/messages) | live· | R | Post title (Reddit posts only). |
| `body` | Text | — | empty | live· | R/D | Main text: post selftext / comment body / Discord message text. The substrate the ticker extractor + direction classifier run over. |
| `flair` | Enum `Flair`/Text | open set | none | live· | R | **Reddit-unique** high-integrity label (DD/YOLO/Gain/Loss/News/Discussion/Meme). Drives `dd_count` + `flair_counts`. Discord has **no flair** → `null`. |
| `roles` | Map | role→present | none | P4 | D | **Discord-unique** author server roles (verified/OG/mod) — the Discord credibility analog to Reddit karma. |
| `score` | Count | ≥0 | live-unsettled | live· | R | Reddit upvotes/score. **Settles ~36 h** (scrapers report it wrong before then) → **not a live signal**. |
| `reaction_counts` | Map | emoji→count | none | P4 | D | **Discord-unique** emoji reactions — a **live** endorsement signal (no 36 h lag, unlike Reddit upvotes). |
| `num_comments` / `num_replies` | Count | ≥0 | unknown | live· | R/D | Reply count under the item (settles like `score` on Reddit; live on Discord). |
| `retrieved_on` | Instant | UTC | — | live· | meta | **Observation time** — when we fetched this snapshot. Bitemporal pair to `created_utc`. |
| `source` | Enum `Source` | `arctic_shift`/… | — | live· | meta | The specific tap. `arctic_shift` is the sole live Reddit tap in v0.0.1. |

### 2.2 `mention` — the atomic empirical event (`R/D`)
The de-dup grain: one row per `(platform, thing, ticker)`. **The source of truth for all empirical features.**

| Field | Type | Domain | Null = | Status | Src | Definition · notes |
|---|---|---|---|---|---|---|
| `ticker` | Symbol | ∈ `instrument` | — | live· | calc | Extracted, whitelist-validated symbol. Precedence: stoplist → whitelist → ambiguous-context gate → `$`-cashtag override. |
| `platform` | Enum `Platform` | `reddit`/`discord` | — | live· | R/D | Denormalized from the item so SoV/momentum compute **per-source and combined**. |
| `thing_id` | Id | — | — | live· | R/D | The producing `content_item` id. |
| `thing_type` | Enum `ContentKind` | `post`/`comment`/`message` | — | live· | R/D | Kind of the producing item. |
| `created_utc` | Instant | UTC | — | live· | R/D | Inherited event time of the item — the value that bucket the mention into a window. |
| `author` | Id | — | deleted/unknown | live· | R/D | Distinct-author counting basis. |
| `flair` | Text | open | none | live· | R | Item flair at mention time (Reddit); on Discord, carry `container` (channel) instead. |
| `direction` | Enum `Direction` | `bull`/`bear`/`neutral` | unclassified | live· | calc | Stance from options/position language (calls/long vs puts/short) — **not** ironic sentiment. `null` = couldn't classify. |
| `weight` | Ratio | ≥0 (default 1.0) | — | live· | calc | Per-mention ticker weight. **v0.0.1 = 1.0** (binary grain: a 20-ticker watchlist post counts all 20 equally). The hook to down-weight incidental mentions later — `1/n` for an `n`-ticker item, or a primary-ticker boost from the LLM classifier — without a re-model. Aggregations sum `weight`; `mentions`/`sov` become weighted once `weight ≠ 1`. |

---

## 3. Empirical features — Family A (`empirical_feature`, grain `ticker × window_start × resolution`)

> *What the **community** is doing.* All fields are **community-sourced** (`R/D`) — **no market data
> required**. This whole family — the "hot" detector — is computable on Reddit alone today.

### 3.1 Attention — how much air-time
| Field | Type | Domain | Null = | Status | Src | Definition · formula · high↔low · related |
|---|---|---|---|---|---|---|
| `mentions` | Count | ≥1 | — | live✓ | R/D | **Distinct posts+comments+messages** naming the ticker this window. `= |{(thing) : thing references T in W}|` (one thing = one mention even if it repeats T). High = more air-time. **A raw count — never the ranker** (a busy sub inflates everyone). Related: `sov`, `velocity`. |
| `authors` | Count | ≥1 | — | live✓ | R/D | **Distinct** accounts mentioning T (bots removed). Robust to one account spamming. 1 = a single voice (`H_e` damped); many = broad attention. Related: `H_e` support shrink. |
| `sov` | UnitInterval | [0,1] | — | live✓ | R/D | **Share of voice — THE primary ranker.** `sov(T,W,r) = mentions(T,W,r) / Σ_t mentions(t,W,r)`. Cross-sectional → needs no history, honest from day one. High = bigger slice of the conversation. (In a quiet window 20% may be 1 of 5 mentions — see `quiet`.) Related: `H_e` (largest weight). |
| `flair_counts` | Map | flair→count | **Reddit absent** (Discord-only cell) | live· | R | Mentions split by Reddit flair (`{"DD":2,"YOLO":7}`). High-integrity segmentation. **`null` = no Reddit data this cell** (gated source absent); an empty `{}` = Reddit present but no flairs. Discord analog = a `container`/channel breakdown. Feeds `dd_count` and flair-direction. |

### 3.2 Momentum — the trending core
| Field | Type | Domain | Null = | Status | Src | Definition · formula · high↔low · related |
|---|---|---|---|---|---|---|
| `velocity` | Real | any (±) | **no prior window** exists (cold start or polling gap) | live✓ | calc(R/D) | 1st derivative of attention: `mentions(W) − mentions(W−1)` for the same resolution. `null` (not 0) when W−1 was never aggregated — else every ticker looks like a breakout. <0 = fading, >0 = building. Needs continuous polling to mean anything. Related: `accel`. |
| `accel` | Real | any (±) | velocity **or its prior** undefined | live✓ | calc(R/D) | 2nd derivative: `velocity(W) − velocity(W−1)`. The **early-breakout** signal — spikes *before* `sov` peaks. `null` when either velocity term is undefined. Negatives are floored to 0 inside `H_e`. Related: `velocity`, `H_e`. |
| `rank` | Count | 1…N | — | txn | calc(R/D) | Position on the `sov` leaderboard (1 = top). Computed today inside the aggregator; **persist it** (model §5.3). |
| `rank_delta` | Real | any (±) | no prior rank → `0` | txn | calc(R/D) | SoV places climbed vs the previous window: `prior_rank − cur_rank`. **+ve = climbing** the board (the headline "trending" event); 0 when the ticker had no prior rank. Feeds `H_e`. Persist it (today only written to the unwritten `signals` table). |
| `z` | Real | ≈[−3,+3] (unbounded) | baseline **not `ready`** or σ=0 | live✓ | calc(R/D) | Anomaly score vs the ticker's **own** norm: `(mentions − μ_base) / σ_base`, baseline = same hour-of-week history (forward-only). Answers "is this unusual *for this ticker*?" `null` until ≥ `min_samples_ready` samples. **Weight 0 in `H_e` until `ready`** — never rank on cold-start `z`. Related: `baseline_status`. |

### 3.3 Direction / stance
| Field | Type | Domain | Null = | Status | Src | Definition · formula · high↔low · related |
|---|---|---|---|---|---|---|
| `net_dir` | SignedUnit | [−1,+1] | — (0 when no directional tokens) | live✓ | calc(R/D) | Bull-vs-bear lean: `(bull − bear) / (bull + bear)` over directional tokens (calls/long/🚀 vs puts/short/"drilling"). **Direction, not ironic sentiment** (WSB sentiment is inverted). −1 fully bearish · 0 mixed/none · +1 fully bullish. `H_e` uses `|net_dir|` (conviction strength, either side). Strengthened by `opt` `pcr` cross-check. |

### 3.4 Conviction — skin in the game
| Field | Type | Domain | Null = | Status | Src | Definition · formula · high↔low · related |
|---|---|---|---|---|---|---|
| `dd_count` | Count | ≥0 | **Reddit absent** (Discord-only cell) | live✓ | R | # of **DD (Due Diligence)** posts on T this window (flair = `DD`). Effortful conviction; often *leads* attention. **Reddit-unique** (flair). `0` = Reddit present, no DD posts (a real observation); `null` = no Reddit data → the conviction term is **excluded from `H_e` and the remaining weights renormalize** (it is **not** treated as 0, which would penalize a Discord-only cell — §10.1). High = more researched conviction. Feeds `H_e` (conviction weight). |
| `yolo_usd` | Money | ≥0 | not extractable | P4 | R/D | Σ of disclosed position size (YOLO/Gain/Loss). Text-extractable subset only at first; full value needs OCR/vision on screenshots. **Per-item evidence**, aggregated to a window total but **never to a win rate**. |

### 3.5 Trust / de-noising
| Field | Type | Domain | Null = | Status | Src | Definition · formula · high↔low · related |
|---|---|---|---|---|---|---|
| `astroturf` | UnitInterval | [0,1] | not yet computed | P4 | R/D | Manipulation flag: share of mentions from <X-day-old accounts / sudden coordinated bursts. **A warning, not a tradeable signal.** High = likely brigading/promo. Higher base rate on Discord (coordination is easier). Related: `author_cred`. |

### 3.6 Composite & metadata
| Field | Type | Domain | Null = | Status | Src | Definition · formula · high↔low · related |
|---|---|---|---|---|---|---|
| `h_e` | UnitInterval | ≈[0,1] | — | live✓ | calc(R/D) | **WSB Heat** — the composite "how hot on WSB right now", and the board ranker. Weighted blend of max-normalized `{sov, accel, rank_delta, authors, conviction(dd), |net_dir|, z*}` × **support shrink** `min(1, authors/min_authors_full)`; `z*` enters only when `ready`. Full formula in [§10](#10-derived-scores--formulas). Cooler→hotter; thin-support rows damped toward 0. |
| `window_start` | Instant | UTC, clock-aligned | — | live✓ | meta | Inclusive lower bound of the half-open window `[window_start, +len(resolution))`. |
| `resolution` | Enum `Resolution` | `15m`/`1h`/`1d` | — | (new) | meta | Window length. `1h` is the v0.0.1 primary (implicit today; **make explicit**). |
| `baseline_status` | Enum `BaselineStatus` | `cold`/`warming`/`ready` | — | live✓ | meta | Whether `z` is trustworthy: `cold` (no same-hour history) → `warming` (some) → `ready` (≥ `min_samples_ready`). `cold` ⇒ ignore `z`. Related: `z`. |
| `total_window_mentions` | Count | ≥0 | — | live✓ | calc | Σ mentions across **all** tickers in this `(window_start, resolution)`. The denominator behind `sov`; the basis of `quiet`. (Surfaced today only in the snapshot meta; the canonical model puts it on the cell.) |
| `quiet` | Boolean | — | — | live✓ | calc | `total_window_mentions < min_window_mentions` ⇒ a **low-confidence** window (off-hours single-mention noise). A window-trust flag every consumer needs → on the cell, not just the snapshot. Consumers must treat a `quiet` cell's `H_e`/rank as low-confidence. |
| `computed_at` | Instant | UTC | — | live· | meta | Observation time — when this cell was derived. |

---

## 4. Analytical features — Family B (`analytical_feature`, grain `ticker × window_start × resolution`)

> *What the **market** is doing.* Gated to the WSB-hot top-N → these rows are a **sparse subset** of
> `empirical_feature`. Sourced from the market funnel (`stk` stock, `opt` options). **Quality is
> feed-dependent** — see `rvol_conf` and [`signals-catalog.md`](./signals-catalog.md).

### 4.1 Price (`stk`)
| Field | Type | Domain | Null = | Status | Definition · formula · high↔low · related |
|---|---|---|---|---|---|
| `ret` | Real | ≈[−1,+∞) | no market data this cell | live✓ | **Window-aligned** return at this resolution: `close(W)/close(W−1) − 1` (or VWAP-to-VWAP). Down→up over the window. `H_m` uses `|ret|` (or `|ret|/realized_vol` once available). **v0.0.1 approximation:** until intraday bars are stored, the current code uses a **day-to-date** return `(latest − prev_close)/prev_close` — a *daily* value repeated across every intraday cell. That makes `H_m` near-static within a day and `divergence` track `H_e` alone; the canonical definition is window-aligned, and quadrant assignment should lean on `1d` resolution until window-aligned `ret` exists ([review fix](./data-model.md#53-derived-rollups-regenerable-grain--instrument--window_start--resolution)). |
| `gap` | Real | ± | — | P4 | Overnight gap: `(today_open − prev_close)/prev_close`. Pre-market positioning. |
| `range` | Real | ≥0 | — | P4 | Intraday range: `(high − low)/prev_close`. Volatility-of-the-day proxy. |
| `realized_vol` | Real | ≥0 | — | P4 | Stdev of returns over trailing *n*. Used to express moves in **vol-units** (`|ret|/realized_vol`) so a 3% move on a calm name outranks 3% on a meme name. |

### 4.2 Volume (`stk`)
| Field | Type | Domain | Null = | Status | Definition · formula · high↔low · related |
|---|---|---|---|---|---|
| `rvol` | Ratio | ≥0 (1 = normal) | no market data | live✓ | **Relative Volume** — the market twin of `sov`/`z`: `vol(T,W) / avg_vol(T, trailing-N same session)`. v0.0.1 crude proxy = day-volume ÷ prev-full-day-volume. <1 quiet, >1 unusually active. **The key "is the market reacting?" metric** — but only as good as the feed (see `rvol_conf`). |
| `rvol_conf` | Enum `Confidence` | `low`/`medium`/`high` | — | live✓ | Confidence in `rvol`, **set by `feed`**: free IEX (~2.5% of volume) ⇒ `low`; paid SIP/IBKR full volume ⇒ `high`. **Consumers must not treat low-confidence `rvol` as ground truth.** The textbook degradation lever. |

### 4.3 Options — the (strike × expiry) matrix (`opt`)
| Field | Type | Domain | Null = | Status | Definition · formula · high↔low · related |
|---|---|---|---|---|---|
| `pcr` | Ratio | ≥0 | no options data | P2 | Put/Call ratio: `put_vol / call_vol`. <1 = call-heavy (typical WSB bullish lotto). A **market** cross-check on community `net_dir`. |
| `iv_rank` | UnitInterval | [0,1] | no options data | P2 | Percentile of at-the-money IV vs trailing ~1y. Level-independent "is IV high?". Rising `iv_rank` + call-heavy = the WSB fingerprint. |
| `iv_skew` | Real | ± | — | P4 | `IV(OTM puts) − IV(OTM calls)` (e.g. 25-delta). Crash-fear vs call-chase. |
| `uoa` | Ratio | ≥0 (≫1 = unusual) | — | P4 | Unusual options activity: contract `vol / OI ≫ 1` → fresh speculative positioning. Drives a key alert (uoa + chatter spike coinciding). |
| `breadth` | UnitInterval *(or Count, simple)* | [0,1] | no options data | P2/P4 | Dispersion of volume across the (strike × expiry) grid. **Simple (P2):** `breadth_strikes` = # distinct active strikes. **Principled (P4):** normalized entropy ∈ [0,1]. **Low** = concentrated single short-dated OTM strike (the classic fragile lotto); **high** = broad, more durable positioning. |

### 4.4 Composite & metadata
| Field | Type | Domain | Null = | Status | Definition · formula · high↔low · related |
|---|---|---|---|---|---|
| `h_m` | UnitInterval | ≈[0,1] | no market data | live✓ | **Market Heat** — "how hard the market is actually moving it". Weighted blend of max-normalized `{|ret|/realized_vol, rvol, z(call_vol), Δiv_rank, uoa}`; v0.0.1 ships `{|ret|, rvol}` only. Calm→moving hard. Only filled for the top-N WSB-hot tickers. Quality scales with feed (see `rvol_conf`) + options availability. |
| `coverage_scope` | Enum `CoverageScope` | `wsb_hot`/`screener_mover`/`both` | — | live· | **Why this ticker has a market row.** `wsb_hot` = fetched because WSB-hot; `screener_mover` = a market-wide screener mover with no WSB heat (a STEALTH candidate, **no matching `empirical_feature` row**); `both`. This is what makes `analytical_feature` independent of `empirical_feature` rather than a subset. |
| `feed` | Enum `Feed` | `iex`/`sip`/`delayed`/`eod` | — | live· | Market-data provenance → confidence. |
| `as_of` | Instant | UTC | — | live· | **Observation time** of the market read — so a `t=0` mention spike is never aligned to stale prices. |

---

## 5. Signal — the product cell *(Phase 3)* (`signal`, grain `ticker × window_start × resolution`)

> The **Attention × Action** product cell — a **full outer join** of Family A + Family B on the grain
> (schema exists, **not populated**, `def`; v0.0.2). A cell exists if **either** heat does: CONFIRMED/
> HYPE come from the empirical side, **STEALTH from the market side with no empirical row** ([data-model
> §5.3](./data-model.md#53-derived-rollups-regenerable-grain--instrument--window_start--resolution)).

| Field | Type | Domain | Null = | Status | Definition · formula · high↔low · related |
|---|---|---|---|---|---|
| `h_e` | UnitInterval | [0,1] | **no empirical row** (a STEALTH cell — market moving, WSB silent) | def→P3 | WSB Heat, carried onto the signal cell. `null` ⇒ treat as WSB-quiet for the quadrant. |
| `h_m` | UnitInterval | [0,1] | no market data | def→P3 | Market Heat, carried on. `null` ⇒ treat as market-quiet for the quadrant. |
| `coverage_scope` | Enum `CoverageScope` | `wsb_hot`/`screener_mover`/`both` | — | def→P3 | Why this cell exists — mirrors `analytical_feature.coverage_scope`. `screener_mover` with null `h_e` = the STEALTH path. |
| `divergence` | SignedUnit | [−1,+1] | **either heat missing** (can't subtract an unknown) | def→P3 | **`h_e − h_m`** (signed) **when both present**, else `null`. Large +ve = hype ahead of market; large −ve = market ahead of WSB. |
| `quadrant` | Enum `Quadrant` | `confirmed`/`hype`/`stealth`/`quiet` | undetermined | def→P3 | Pure function of `(h_e, h_m)` vs each one's rolling median, **treating a missing heat as "quiet" on that axis**: **confirmed** (both hot), **hype** (WSB hot, market quiet), **stealth** (market hot, WSB quiet/absent), **quiet** (both low). So a STEALTH cell (null `h_e`) still gets a badge even though `divergence` is null. |
| `rank` / `rank_delta` | Count / Real | 1…N / ± | — | def→P3 | Board position and its change on the combined product (mirror of §3.2, persisted here). |
| `lead_lag_hrs` | Duration (hours) | ± | insufficient history | def→P3 | Per-ticker argmax of the cross-correlation between `H_e(t)` and `H_m(t)` over a trailing window. **+ve = WSB attention leads market by ~x h.** **Reports association, not prediction** (reflexivity caveat). Needs stored `H_e/H_m` series. |
| `computed_at` | Instant | UTC | — | def→P3 | Observation time of the signal derivation. |

---

## 6. Baselines (`baseline`, grain `ticker × resolution × bucket_scheme × seasonal_bucket`)

> Seasonal reference stats for `z`. Schema exists but is **unused** today (the aggregator recomputes on
> the fly) — a correctness gap to materialize, generalized per resolution. (`calc(R/D)` for empirical,
> `stk` for the market analog.)

| Field | Type | Domain | Null = | Status | Definition · notes |
|---|---|---|---|---|---|
| `ticker` | Symbol | ∈ `instrument` | — | def | The instrument. |
| `resolution` | Enum `Resolution` | `15m`/`1h`/`1d` | — | (new) | Which rollup these baselines serve. |
| `bucket_scheme` | Enum `BucketScheme` | `hour_of_week`/`day_of_week`/`time_of_day`/… | — | (new) | Seasonality scheme **chosen per resolution for warmup speed** (`B` buckets ⇒ ~`B × min_samples_ready` windows to `ready`): `1h`→`hour_of_week`/168 (~8 wk); `15m`→**`time_of_day`/96** (days, drops day-of-week seasonality) *not* `quarter_hour_of_week`/672 (months); `1d`→`day_of_week`/7. |
| `seasonal_bucket` | SeasonalBucket | 0…(buckets−1) | — | def | The recurring calendar slot index (e.g. Mon 00:00 UTC = 0). |
| `mention_mean` | Real | ≥0 | insufficient samples | def | Trailing mean of `mentions` for this slot — μ in `z`. |
| `mention_std` | Real | ≥0 | insufficient samples | def | Trailing std — σ in `z`. |
| `sample_count` | Count | ≥0 | — | def | # observations in the slot — gates `status` (`ready` at ≥ `min_samples_ready`). |
| `status` | Enum `BaselineStatus` | `cold`/`warming`/`ready` | — | def | Per-slot readiness (mirrors `empirical_feature.baseline_status`). |
| `vol_mean` | Real | ≥0 | no market data | def | Market analog (avg volume for the slot) — basis for `rvol`'s denominator. `stk`. |
| `updated_at` | Instant | UTC | — | def | Last rolling recompute. |

---

## 7. Market raw streams

### 7.1 `market_bar` — OHLCV *(defined, not written)* (`stk`)
| Field | Type | Domain | Null = | Status | Definition |
|---|---|---|---|---|---|
| `ticker` | Symbol | ∈ `instrument` | — | def | Instrument. |
| `bar_ts` | Instant | UTC | — | def | Bar start (event time). |
| `open`/`high`/`low`/`close` | Money | ≥0 | — | def | OHLC prices. **Decimal**, never float. |
| `volume` | Count | ≥0 | — | def | Shares traded in the bar. Fidelity = feed (IEX thin → SIP/IBKR full). |
| `vwap` | Money | ≥0 | unavailable | def | Volume-weighted average price. |
| `feed` | Enum `Feed` | `iex`/`sip`/… | — | def | Provenance → confidence. |
| `as_of` | Instant | UTC | — | def | Observation time. |

### 7.2 `options_contract` — the raw chain, per strike × expiry × right *(new; raw)* (`opt`)
The **contract-level raw** from which every options aggregate is derived. Keeping this grain is what makes
entropy `breadth`, `uoa`, and `iv_skew` **re-derivable and tunable** — a pre-aggregated snapshot can't.

| Field | Type | Domain | Null = | Status | Definition |
|---|---|---|---|---|---|
| `ticker` | Symbol | ∈ `instrument` | — | P2 | Underlying. |
| `snap_ts` | Instant | UTC | — | P2 | Snapshot time (event). |
| `expiry` | Instant | UTC | — | P2 | Contract expiration. |
| `strike` | Money | ≥0 | — | P2 | Strike price (decimal). |
| `right` | Enum `OptionRight` | `call`/`put` | — | P2 | Contract type. |
| `volume` | Count | ≥0 | — | P2 | Contracts traded this snapshot. |
| `open_interest` | Count | ≥0 | — | P2 | Open interest; basis for `uoa = vol/OI`. |
| `iv` | Real | ≥0 | unavailable | P2 | Per-contract implied volatility. |
| `delta`/`gamma`/`vega`/`theta` | Real | ± | unavailable (no Greeks tier) | P4 | Greeks (when the feed provides them). |
| `feed` / `as_of` | Enum / Instant | — | — | P2 | Provenance / observation time (free tiers ~15-min delayed). |

### 7.3 `options_snapshot` — chain aggregate *(derived from `options_contract`)* (`opt`)
A per-`(ticker, snap_ts)` rollup of `options_contract`. May be ingested directly when a feed exposes only
chain aggregates (degraded — then `options_contract` is empty and entropy `breadth` is unavailable).

| Field | Type | Domain | Null = | Status | Definition |
|---|---|---|---|---|---|
| `ticker` | Symbol | ∈ `instrument` | — | def | Underlying. |
| `snap_ts` | Instant | UTC | — | def | Snapshot time (event). |
| `call_vol`/`put_vol` | Count | ≥0 | — | def→P2 | Contract volume by type. |
| `pcr` | Ratio | ≥0 | — | def→P2 | `put_vol/call_vol`. |
| `call_oi`/`put_oi` | Count | ≥0 | — | def→P4 | Open interest; its change = real positioning, not churn. |
| `atm_iv` | Real | ≥0 | — | def→P2 | At-the-money implied volatility. |
| `iv_rank` | UnitInterval | [0,1] | — | def→P2 | Percentile of `atm_iv` vs ~1y. |
| `iv_skew` | Real | ± | — | def→P4 | OTM-put minus OTM-call IV. |
| `uoa` | Ratio | ≥0 | — | def→P4 | `vol/OI` unusual-activity ratio. |
| `breadth_strikes`/`breadth_expiries` | Count | ≥0 | — | def→P2 | Distinct active strikes / expiries (simple breadth). |
| `breadth_entropy` | UnitInterval | [0,1] | not computed (simple mode) | def→P4 | Normalized entropy of volume over the (strike×expiry) grid (principled breadth). |
| `feed` / `as_of` | Enum / Instant | — | — | def | Provenance / observation time (options are often 15-min delayed on free tiers). |

### 7.4 `market_mover` — screener capture (market-wide read) (`stk`)
| Field | Type | Domain | Null = | Status | Definition |
|---|---|---|---|---|---|
| `ts` | Instant | UTC | — | live· | Capture time. |
| `kind` | Enum `MoverKind` | `active`/`gainer`/`loser` | — | live· | Screener list type. |
| `rank` | Count | 1…N | — | live· | Position in that list (1 = top). |
| `symbol` | Symbol | — | — | live· | The moving instrument (may be outside the WSB-hot set — that's the point). |
| `price` | Money | ≥0 | unavailable | live· | Last price. |
| `percent_change` | Real | ± | unavailable | live· | Day percent move. |
| `volume` | Count | ≥0 | unavailable | live· | Day volume. |

> The bounded market-wide read powering **STEALTH** (screener movers ∖ WSB-hot, liquidity-filtered).
> Captured today; *detection* is Phase 3.

### 7.5 `ingestion_run` — coverage / provenance of each raw pull *(new)* (`meta`)
Makes ingest completeness a first-class, queryable fact — a near-live radar's `sov` denominator is only
as honest as the pull behind it. The structured form of `wsb heartbeat` + the `[CAP]` canary.

| Field | Type | Domain | Null = | Status | Definition |
|---|---|---|---|---|---|
| `source` | Enum `Source` | `arctic_shift`/… | — | (new) | The tap pulled. |
| `kind` | Enum | `post`/`comment`/`message`/`market` | — | (new) | What was pulled. |
| `poll_ts` | Instant | UTC | — | (new) | When the pull ran (observation time). Natural key with `source`+`kind`. |
| `cursor` | Text | — | first pull | (new) | Pagination/since token carried forward. |
| `oldest_item` / `newest_item` | Instant | UTC | nothing fetched | (new) | Event-time span actually fetched. |
| `items_fetched` | Count | ≥0 | — | (new) | Rows returned this pull. |
| `pages` | Count | ≥0 | — | (new) | Pages walked. |
| `capped` | Boolean | — | — | (new) | Hit the pagination cap ⇒ **the window may be incomplete** → its `sov` is untrustworthy (invariant 14). |
| `lag_seconds` | Duration (s) | ≥0 | tap returned nothing | (new) | Newest item vs wall clock — the freshness/staleness measure. |
| `status` | Enum | `ok`/`stale`/`down` | — | (new) | Heartbeat verdict (mirrors `wsb heartbeat` exit codes). |

---

## 8. Enrichment *(Phase 4 — per-item; survivorship firewall)*

### 8.1 `engagement_settled` (`R/D`)
| Field | Type | Domain | Null = | Status | Definition |
|---|---|---|---|---|---|
| `platform`/`thing_id`/`thing_type` | Enum/Id | — | — | P4 | Identifies the reconciled `content_item`. |
| `ticker` | Symbol | — | none | P4 | Convenience denormalization (optional). |
| `upvotes` | Count | ≥0 | n/a (Discord) | P4 | Reddit settled upvotes (>36 h). |
| `reaction_total` | Count | ≥0 | n/a (Reddit) | P4 | Discord total reactions (live). |
| `num_comments`/`num_replies` | Count | ≥0 | unknown | P4 | Settled reply count. |
| `awards` | Count | ≥0 | unknown | P4 | Reddit awards. |
| `eng_per_mention` | Ratio | ≥0 | — | P4 | `upvotes / mentions` — separates endorsed chatter from noise. **Only on settled data.** Feeds a *separate settled `H_e`* for tuning/backtests — **never the live `H_e`**. |
| `settled_at` | Instant | UTC | — | P4 | When this reconciliation was taken. |

### 8.2 `post_classification` (`R/D` — LLM)
| Field | Type | Domain | Null = | Status | Definition |
|---|---|---|---|---|---|
| `platform`/`thing_id` | Enum/Id | — | — | P4 | Identifies the classified `content_item`. |
| `ticker` | Symbol | — | none | P4 | The item's primary ticker (if any). |
| `is_option_play` | Boolean | — | unknown | P4 | Whether the post is an options trade vs shares. |
| `llm_stance` | Enum `Direction` | `bull`/`bear`/`neutral` | unclassified | P4 | LLM-assessed stance (stronger than keyword `net_dir`). |
| `yolo_usd` | Money | ≥0 | not disclosed | P4 | Position size (incl. vision-on-screenshot). |
| `reported_pnl` | Money | ± | not disclosed | P4 | Self-reported profit/loss. |
| `win_loss` | Enum `WinLoss` | `win`/`loss`/`breakeven` | unknown | P4 | Outcome label. |
| `model` | Text | — | — | P4 | Which LLM/version produced this (provenance). |
| `classified_at` | Instant | UTC | — | P4 | Derivation time. |

> **HARD CONSTRAINT (survivorship firewall):** `reported_pnl` / `win_loss` / `yolo_usd` are **per-item
> evidence only**. There is **no aggregation path** to a per-ticker win rate (winners post, losers go
> quiet — [signal-framework §9](./signal-framework.md)). Enforced by the absence of a rollup entity.

---

## 9. Published serialization fields (snapshot JSON / history Parquet)

Not core-model columns — the **presentation contract** the dashboard reads (lock-free, sidestepping the
single-writer DB). Listed so "all published columns" is fully covered.

| Field | Type | Where | Definition |
|---|---|---|---|
| `name` | Text | snapshot, movers | Prettified company name (`pretty_name(instrument.name)`). |
| `name_raw` | Text | history.parquet | Un-prettified `instrument.name` (dashboard applies `pretty_name`). |
| `window_start`/`window_end`/`window_seconds` | Instant/Instant/Duration(s) | snapshot meta | The window the snapshot covers + its length. |
| `generated_at` | Instant | snapshot meta | When the snapshot was written. |
| `total_mentions` | Count | snapshot meta | Σ mentions across all rows this window. |
| `quiet` | Boolean | snapshot meta | `total_mentions < min_window_mentions` → the board is low-confidence (off-hours single-mention noise). Bannered in the UI. |
| *(per-row)* `rank, ticker, name, mentions, authors, sov, velocity, accel, z, net_dir, dd_count, baseline_status, h_e` | — | snapshot rows | The published empirical columns (definitions above). |
| *(per-row)* `ret, rvol, rvol_conf, h_m` | — | snapshot rows | The published market columns (null outside the top-N). |
| *(movers)* `symbol, name, kind, rank, price, percent_change, volume` | — | snapshot `movers` | Screener capture for the STEALTH teaser. |
| `dt` / `date` / `display` | Instant/Date/Text | dashboard-derived | Convenience columns the dashboard adds when loading `history.parquet` (not persisted). |

---

## 10. Derived scores & formulas

The exact, agnostic definitions of the composites and the normalization that makes the components
comparable. (Implementation: `wsb_signals/aggregate.py`.)

### 10.1 Null-handling in composites
`null` ≠ `0` — and the two null *classes* are handled differently inside `H_e`/`H_m` (this is the rule
the data-model principle §1.5 points at):

- **Undefined-momentum null** — `velocity`/`accel` with no prior window. **Coalesce to 0** in the blend:
  there is genuinely no momentum to add, and a fresh breakout must still rank on `sov`/`authors`. (It is
  *not* dropped, so the denominator is unchanged.)
- **Source-absent null** — a gated component whose source isn't present this cell (`dd_count`/`flair`
  on a Discord-only cell; `z` before `baseline_status = ready`). **Exclude the term and renormalize the
  remaining weights** (`H_e = Σ_present w_i·n_i / Σ_present w_i`). Substituting 0 would *penalize* the
  cell for a missing source — e.g. zero-out Discord conviction or punish a cold-start ticker. `z` is the
  canonical case already encoded (weight 0 until `ready`); the same rule governs every gated component.

A consequence: a cell never inherits a spurious score from a source it can't see, and an all-community
Reddit cell and a Discord-only cell are scored on the components each actually has.

### 10.2 Max-normalization (NOT percentile rank)
Each `H_e` component is scaled to `[0,1]` by the **window maximum**, negatives floored to 0; an all-zero
component yields zeros:

```
max_norm(x_i) = max(0, x_i) / max_j(x_j)     if max_j(x_j) > 0   else 0
```

**Why max-norm, not percentile rank:** `H_e` must stay **SoV-primary**. Percentile rank flattens the
1st-vs-2nd SoV gap (letting a secondary like `net_dir` override the primary signal) and hands tied
all-zero components (a first window's `rank_delta`/`dd_count`) a spurious `1.0`. Max-norm preserves the
leader's magnitude and zeroes empty components.

> **Cross-window caveat (review finding).** Max-norm is **within-window**, so `H_e` is *not* comparable
> across windows: a quiet-Sunday leader and a Monday-open mega-breakout can both normalize to ~1.0. The
> `quiet` flag + `support_shrink` blunt the worst off-hours false positives for the *live board*, but
> the **`H_e(t)` time-series, `divergence`, and lead-lag need cross-window comparability** — there,
> anchor normalization to a **trailing absolute reference** (e.g. the ticker's/board's rolling 7-day
> high or a robust percentile) rather than the instantaneous window max. Tracked for the v0.0.2 product
> layer; the within-window form remains correct for the single-window leaderboard.

### 10.3 WSB Heat `H_e` (live, community-only)
```
H_e(T,W) = [  w_sov · n(sov)
            + w_accel · n(max(0, accel))
            + w_rank_delta · n(rank_delta)
            + w_authors · n(authors)
            + w_conviction · n(dd_count)
            + w_net_dir · |net_dir|
            + (w_z · n(z)  if baseline_status == ready  else 0) ]
         × support_shrink
```
where `n(·)` = `max_norm` over the window, and
```
support_shrink = min(1, authors / min_authors_full)        (when min_authors_full > 0)
```
**Support shrink** damps the *absolute* `H_e` of thin-evidence rows: in a quiet window a single mention
max-norms to 1.0 on every component, so without this a lone comment scores ~0.75 and ranks #1. With
`min_authors_full = 3`, 1 author ⇒ ×⅓. This is an **absolute-confidence** axis, distinct from the
relative `authors` component. `|net_dir|` is used (conviction strength either side), not signed
`net_dir`. **`z` contributes only when `ready`** (weight 0 otherwise — never faked). Source-absent
components (`dd_count`, etc.) follow the **renormalize** rule in [§10.1](#101-null-handling-in-composites),
not zero-substitution.

### 10.4 Market Heat `H_m` (analytical)
```
H_m(T,W) = w_ret · n(|ret| / realized_vol)   ← v0.0.1: n(|ret|)  (realized_vol is P4)
         + w_rvol · n(rvol)
         + w_pcr · (options term)             ← P2/P4
         + w_iv  · (options term)             ← P2/P4
```
Same max-norm. v0.0.1 ships `{ret, rvol}` only; `pcr`/`iv` weights are 0 until the options increment.
**Quality is feed-gated** (`rvol_conf`): on free IEX volume `H_m` is directionally useful but not
ground truth; a paid SIP/IBKR feed sharpens it. Absent options → `H_m` simply lacks the options
dimension (degraded, not broken).

### 10.5 Divergence & quadrant *(Phase 3)*
```
divergence(T,W) = H_e − H_m  (only when BOTH present, else null)   ∈ [−1, +1]
quadrant(T,W)   = f(H_e vs median(H_e), H_m vs median(H_m))
                  → CONFIRMED | HYPE | STEALTH | QUIET
```
Split each heat at its rolling median only when both axes have a populated rolling sample and the
ticker row clears the distinct-author support floor. Otherwise the quadrant is `null`; missing market
evidence is never fabricated as quiet. Market-wide screener rows remain a separate, liquidity-filtered
context table. They do not create empirical cells, divergence, quadrants, or automatic STEALTH labels.

### 10.6 Lead-lag *(Phase 3)*
```
lead_lag_hrs(T) = argmax_τ  corr( H_e(t), H_m(t+τ) )   over a trailing window
```
`+ve` ⇒ WSB attention leads market action by ~τ hours. Needs the stored `H_e(t)`/`H_m(t)` series.
**Computed at a single stated resolution** (the `1h` series is the primary; don't mix resolutions in one
cross-correlation) over a trailing window long enough to be meaningful — at `1d` you have too few samples
for a trustworthy argmax, so badge it low-confidence until the series is long enough. The most credible —
and most caveated — thing the radar claims.

---

## 11. Tunable parameters (configuration, not data)

These live in config (`config.toml` today), not the data store, but they **define column behaviour** —
documented here so the definitions above are reproducible. Defaults are v0.0.1 values; tune in Phase 4.

| Parameter | Default | Affects | Meaning |
|---|---|---|---|
| `heat.weights.{sov,accel,rank_delta,authors,conviction,net_dir,z}` | `0.35/0.15/0.15/0.15/0.10/0.10/0.00` | `h_e` | Component blend; `sov` primary; `z` zeroed until `ready`. |
| `heat.min_authors_full` | `3` | `h_e` | Support-shrink denominator (distinct authors for full weight). |
| `heat.min_window_mentions` | `20` | `quiet` | Below this total-window mentions ⇒ snapshot flagged low-confidence. |
| `baseline.min_samples_ready` | `8` | `z`, `baseline_status` | Per-`(ticker,slot)` sample floor before `z` is trusted (effective floor is `max(2, …)`). |
| `baseline.bucket_scheme[resolution]` | `1h:hour_of_week`, `15m:time_of_day`, `1d:day_of_week` | `baseline`, `z` | Per-resolution seasonality scheme (warmup-speed trade-off; §6, §10). |
| `market.weights.{ret,rvol,pcr,iv}` | `0.5/0.5/0.0/0.0` | `h_m` | Market-heat blend; `pcr`/`iv` enter with options. |
| `platform_weights.{reddit,discord}` | `1.0/0.0` (Reddit-only today) | combined `sov`/`H_e` | Across-platform blend weights for the combined community SoV (per-source SoV × weight, summed; never pooled counts). Discord weight > 0 once Discord is live. |
| `market.top_n` | `25` | `coverage_scope=wsb_hot` rows | Fetch market data for the top-N WSB-hot tickers. |
| `market.screener_top` | `25` | `market_mover`, `coverage_scope=screener_mover` rows | Screener list size (STEALTH candidate pool). |
| `market.feed` | `iex` | `rvol_conf`, `h_m` quality | Stock feed → volume confidence. |
| `ingest.window_seconds` | `3600` | `resolution`, all windowing | Primary window length (1h). The basis for the explicit `resolution` dimension. |
| `ingest.poll_seconds` | `300` | freshness | Poll cadence (5 min). |
| `ingest.lateness_horizon_windows` | `1` | late-arrival re-aggregation | How many closed windows back a late event triggers a recompute (data-model §7). |
| `heartbeat.max_staleness_seconds` | `1800` | source health, `ingestion_run.status` | Alarm if the newest tap item is older than this. |
