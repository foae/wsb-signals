# Data Model (canonical, storage-agnostic)

> The **rock-solid, implementation-agnostic** data model for WSB Signals. It defines *what* we store
> and *how the things relate* — entities, grain, keys, relationships, logical types — **without
> committing to a physical store**. It is designed to survive the migration to a dedicated repo and
> to drop cleanly onto **either an RDBMS (Postgres + TimescaleDB)** *or* **a document store**.
>
> **Companion artifacts (keep all in sync):**
> - [`data-dictionary.md`](./data-dictionary.md) — the per-field reference: every column's definition,
>   formula, domain, null semantics, lifecycle, source, and caveats.
> - [`signals-catalog.md`](./signals-catalog.md) — *what* can be inferred from *where*: every signal
>   mapped to its required inputs, its source(s) (Reddit / Discord / stock / options), whether it is
>   available today, and how its quality degrades when a source is thin or absent.
> - [`schema/`](./schema/) — the machine-readable canonical contract: one JSON Schema per entity, plus
>   [`schema/_common.json`](./schema/_common.json) holding the logical-type vocabulary and enums (`$defs`).
> - The conceptual source of truth for *why* each signal exists is [`signal-framework.md`](./signal-framework.md);
>   the running-system view is [`architecture.md`](./architecture.md).
>
> **Design for full access; build for graceful degradation.** The model is designed *as if* we already
> have full Reddit **and** Discord chatter **and** a complete market funnel (real-time full-volume
> prices **and** the options matrix). It is **source-modular**: a missing or thin source never breaks
> the pipeline — it only makes some signals **impossible** to compute (they go `null`) or **lower
> quality** (flagged via confidence), while the signals that don't depend on it keep working. Example:
> identifying a **hot / hyped** ticker needs only community chatter + a stock price (both available
> today); a thin volume feed degrades the *quality* of the market-confirmation signal but does not stop
> us flagging the ticker as hot. Every signal's dependencies and degradation are catalogued in
> [`signals-catalog.md`](./signals-catalog.md).
>
> **Physical types are deliberately absent.** "Use `int8` vs `int4`", "JSONB vs child table",
> "`timestamptz` vs epoch-bigint", partitioning, and indexing are **implementation-time** decisions.
> This document fixes the *logical* contract so those choices can't introduce semantic drift.

---

## 1. Modeling principles (non-negotiable)

These principles are *load-bearing*. Violating one silently corrupts a signal.

1. **Storage-agnostic logical types.** Every attribute is typed from a fixed
   [logical-type vocabulary](#3-logical-type-vocabulary) (e.g. `UnitInterval`, `Count`, `Instant`),
   never a physical type. An implementation maps logical → physical once, in one place.
2. **Event-sourced.** The **raw event streams** (`content_item`, `mention`, `market_bar`,
   `options_contract`, `market_mover`) are the **append-only source of truth**. Everything else
   (`empirical_feature`, `analytical_feature`, `signal`, `baseline`, `options_snapshot`) is a **derived
   rollup** that can be **recomputed from the raw streams**. If a derived table is dropped, it is
   regenerable; if a raw stream is lost, data is gone. Treat the two layers with different
   durability/backup expectations. `ingestion_run` records *coverage/provenance* of the raw pulls (it is
   itself append-only metadata, not regenerable).
3. **Multi-resolution by construction.** Feature/signal cells carry an explicit **`resolution`**
   dimension (`15m` / `1h` / `1d` / …). The grain is **`(instrument, window_start, resolution)`**, not a
   hardcoded hour. Adding a resolution is *data*, never a schema change. The simple time-bucket rollups
   map onto Timescale **continuous aggregates** (one per resolution) or document **rollup collections**;
   the calendar-*seasonal* rollups (`baseline`) need scheduled materialized views / refresh jobs (see
   [§7](#7-the-multi-resolution-rollup-model), [§8.1](#81-rdbms--postgres--timescaledb-the-stated-direction)).
4. **Bitemporal: event time ≠ observation time.** Every record separates **when the thing happened**
   (`event_time` family: `created_utc`, `window_start`, `bar_ts`) from **when we saw/derived it**
   (`observation_time` family: `retrieved_on`, `as_of`, `computed_at`). A `t=0` mention spike must
   never be silently aligned to a stale price — provenance (`feed`, `as_of`, `source`) rides with the
   data so consumers can reason about lag.
5. **`null` means "undefined", never "zero".** A measured zero (0 mentions, 0% return) is a *value*.
   `null` means the quantity **could not be computed this cell** — no prior window (`velocity`/`accel`),
   baseline not `ready` (`z`), ticker outside the market top-N (`ret`/`rvol`/`h_m`), or the **source is
   absent** (a `reddit`-gated `dd_count`/`flair_counts` on a Discord-only cell). Consumers and
   aggregations must distinguish them; the dictionary states each field's null trigger. **A composite
   (`H_e`/`H_m`) handles a null component by class** (see [§10.1](#101-null-handling-in-composites)):
   an *undefined-momentum* null (`velocity`/`accel` with no prior) coalesces to **0** (neutral — no
   momentum to add); a *source-absent* null (`dd_count`/`z` unavailable) is **excluded and the remaining
   weights are renormalized** — never substituted with 0, which would penalize the cell for a missing
   source.
6. **Survivorship firewall.** Outcome / P&L / win-loss data (`reported_pnl`, `win_loss`, `yolo_usd`)
   lives **per-post only and is NEVER aggregated to a per-ticker win rate** (winners post, losers go
   quiet — [signal-framework §9](./signal-framework.md)). This is a *modeling constraint*, enforced by
   keeping those fields on a per-post entity with no rollup path, not just a convention.
7. **Rank on `sov`, surface `z` only when `ready`.** Normalization is part of the contract, not an
   implementation detail: components are **max-normalized within a window** (not percentile-ranked),
   `H_e` is **SoV-primary**, and `z` carries weight only once its baseline reaches `ready`
   ([signal-framework §4](./signal-framework.md)). See [§11 invariants](#11-invariants--constraints).
8. **Reference data is dimensional.** `instrument` (the tradable universe + names) and `author` are
   **slowly-changing reference dimensions**, separate from the high-volume event/feature streams.
9. **Source-modular by construction.** Community chatter is modelled as a single generalized
   `content_item` (`platform` ∈ {`reddit`, `discord`, …}), so adding Discord is *data*, not a redesign.
   Market data sits behind a funnel (stock + options). **Every derived signal declares its input
   dependencies and its degradation mode** (`core` / `enriched` / `gated` — see
   [signals-catalog.md](./signals-catalog.md)): when an input source is absent the dependent signal is
   `null` (gated) or computed at reduced quality (`enriched`, flagged via `Confidence`), and signals
   that don't depend on it are unaffected. The model encodes this so the pipeline computes *what it can*
   and explicitly marks the rest — never silently substituting zeros or stale values.
10. **A ticker enters the feature layer via a `coverage_scope`, not only via WSB chatter.** Market data
    is fetched for the **WSB-hot top-N** *and* for **screener movers** (a market-wide read). So an
    `analytical_feature`/`signal` cell can exist for a ticker with **no `empirical_feature` row at all**
    — that is precisely a **STEALTH** candidate (market moving, WSB silent). `empirical_feature` and
    `analytical_feature` are therefore **independent rollups joined on the grain** (a *full outer join*),
    not a strict subset; each `signal` cell carries the `coverage_scope` that pulled it in. (This corrects
    an earlier over-strong "analytical ⊆ empirical" invariant — see [§5.3](#53-derived-rollups-regenerable-grain--instrument--window_start--resolution), [§11](#11-invariants--constraints).)
11. **Late-arriving data is bounded, not assumed away.** Tap latency means an event can arrive after its
    window has closed. Windows are **re-aggregated for a bounded lateness horizon** (the current + the
    immediately-finalized prior window today); an event older than the horizon is **late-bucketed into
    its true window and the cell recomputed**, or dropped with a flag — never silently attributed to the
    current window (which would corrupt `velocity`/`accel` at boundaries). The horizon is config; ingest
    completeness is tracked in `ingestion_run` (see [§7](#7-the-multi-resolution-rollup-model)).

---

## 2. Layered architecture

```
 REFERENCE (slowly-changing dimensions)
   instrument ──< (symbol)                       author ──< (username)   [P4]
       ▲                                              ▲
       │ symbol                                       │ username
 ──────┼──────────────────────────────────────────────┼───────────────────────────
 RAW EVENT STREAMS (append-only — source of truth; bitemporal)   [ingestion_run: coverage/provenance]
   content_item                              market_bar        market_mover (screener; market-wide)
     platform ∈ {reddit, discord}           options_contract  (per strike×expiry×right — the raw chain)
     kind ∈ {post, comment, message}
     (self-threaded via parent_id/root_id)
        └──< produces >──┐
                          ▼
                      mention   ← the ATOMIC empirical event: one (ticker × content_item) reference
                          │            (event_time = created_utc; carries platform, flair, direction, author)
 ───────────────────────────┼─────────────────────────────────────────────────────
 DERIVED ROLLUPS (regenerable; grain = instrument × window_start × resolution)
   mention          ──aggregate──►  empirical_feature ─┐ (WSB-hot scope)
   market_bar       ──aggregate──►  analytical_feature ┼──FULL OUTER JOIN──►  signal
   options_contract ──aggregate──►  options_snapshot ──┘ (WSB-hot ∪ screener-mover)   (H_e×H_m →
                                                          coverage_scope per cell      divergence/quadrant/
   empirical_feature ──rolling stats──► baseline (seasonal: ticker × resolution × seasonal_bucket)   lead-lag)
 ───────────────────────────────────────────────────────────────────────────────
 POST-HOC / ENRICHMENT (per-item; NO per-ticker aggregation)             [P4]
   content_item ──reconcile (>36h / live reactions)──► engagement_settled
   content_item ──LLM classify────────────────────────► post_classification   (survivorship firewall §1.6)
```

`[P4]` = Phase-4 (enrichment); see [§12 lifecycle & current implementation](#12-lifecycle--mapping-to-the-current-v001-implementation)
for what exists today vs what is planned.

---

## 3. Logical type vocabulary

The complete set of logical types. An implementation binds each to one physical type **once**.
The "RDBMS hint" / "Document hint" columns are **non-binding guidance**, not requirements.

| Logical type | Meaning & domain | Null allowed? | RDBMS hint (non-binding) | Document hint (non-binding) |
|---|---|---|---|---|
| `Symbol` | Instrument identifier; short uppercase ticker (`AVGO`, `SPY`). Natural key of `instrument`. | no | short `varchar`, indexed | string |
| `Id` | Opaque external identifier (Reddit "thing" id, e.g. `t3_abc123`, `t1_def456`). | no | `varchar` PK | string `_id` |
| `Text` | Free Unicode text, unbounded (titles, bodies). | yes | `text` | string |
| `Enum{…}` | Closed set of string tokens — see [§4](#4-enumerations). | per field | `varchar` + CHECK / native enum | string (validated) |
| `Count` | Cardinal integer **≥ 0** (mentions, authors, volume, dd_count, breadth). | per field | unsigned-ish integer | integer |
| `Real` | Signed real number, unbounded (`velocity`, `accel`, `z`, `ret`). Differences/derivatives/z-scores. | per field | floating / numeric | number |
| `UnitInterval` | Real in **[0, 1]** (`sov`, `h_e`, `h_m`, normalized components, `iv_rank`, entropy `breadth`). | per field | numeric/float, CHECK [0,1] | number |
| `SignedUnit` | Real in **[−1, +1]** (`net_dir`). | per field | numeric/float, CHECK [−1,1] | number |
| `Ratio` | Real **≥ 0**, multiplicative; **1.0 = parity/normal** (`rvol`, `pcr`). | per field | numeric/float | number |
| `Money` | **Decimal** currency amount (`yolo_usd`, `reported_pnl`, `price`). **Never binary float** (rounding). Currency is USD unless a `currency` field says otherwise. | per field | `numeric(.,.)` / `decimal` | decimal string / Decimal128 |
| `Instant` | A point in time, **UTC**. Event- or observation-time. (`created_utc`, `window_start`, `bar_ts`, `as_of`, `retrieved_on`, `computed_at`). | per field | `timestamptz` **or** epoch-`bigint` | epoch integer / ISO-8601 string |
| `Duration` | Elapsed time; **logical unit declared per field** (`lead_lag_hrs` = hours, `max_staleness` = seconds). | per field | numeric + documented unit | number + documented unit |
| `SeasonalBucket` | Integer index of a recurring calendar slot within a `bucket_scheme` (e.g. hour-of-week 0…167). | no | small integer | integer |
| `Map<Symbol→Count>` | Keyed multiset; canonical shape of `flair_counts` (`{"DD":3,"YOLO":7}`). Normalizable to a child relation. | per field | `JSONB` **or** child table | embedded object |
| `Boolean` | True/false (`quiet`, `is_option_play`, `astroturf`). | per field | `boolean` | boolean |

**Rationale for the distinctions** (these prevent the "type mismatch" the spec must avoid):
- `Count` vs `Real`: counts are non-negative integers; *derivatives of counts* (`velocity`, `accel`)
  are signed reals — in a fixed window they happen to be integer-valued, but the type must permit
  negatives and rates, so they are `Real`, not `Count`.
- `UnitInterval` vs `Ratio` vs `SignedUnit`: bounded-[0,1] scores, unbounded-≥0 multiplicative ratios,
  and bounded-[−1,1] balances are three different domains. Collapsing them loses the CHECK constraints
  that catch a broken computation early.
- `Money` is decimal on purpose. Storing money as a float is a defect, not an implementation choice.
- `Instant` is logical: epoch-bigint (current DuckDB) and `timestamptz` (likely Postgres) are both
  valid bindings — but **all instants are UTC**, and event-time vs observation-time is semantic, not
  type-level (the dictionary tags each).

---

## 4. Enumerations

Closed value sets. New members are *config/data*, but the **set is part of the contract** — consumers
may switch on these. Unknown/unclassified is represented by `null` (not a sentinel string) unless a
member is listed for it.

| Enum | Members | Used by | Notes |
|---|---|---|---|
| `Platform` | `reddit`, `discord` (extensible) | `content_item.platform`, `mention.platform` | The community source. Drives which fields apply (flair=reddit, channel/roles=discord) and which signals are computable. |
| `ContentKind` | `post`, `comment`, `message` | `content_item.kind`, `mention.thing_type` | `post`/`comment` = Reddit; `message` = Discord. Generalizes the old Reddit-only `ThingType`. |
| `Direction` | `bull`, `bear`, `neutral` | `mention.direction` | From options/position language, **not** ironic sentiment. `null` = unclassified. |
| `BaselineStatus` | `cold`, `warming`, `ready` | `empirical_feature.baseline_status`, `baseline.status` | Gates `z` trust (cold → ignore z; ready → trusted). |
| `Resolution` | `15m`, `1h`, `1d` (extensible) | feature/signal/baseline grain | The rollup window length. `1h` is the v0.0.1 primary. |
| `Quadrant` | `confirmed`, `hype`, `stealth`, `quiet` | `signal.quadrant` | Divergence quadrant ([signal-framework §6.1](./signal-framework.md)). Phase 3. |
| `MoverKind` | `active`, `gainer`, `loser` | `market_mover.kind` | Screener list type (market-wide read). |
| `Confidence` | `low`, `medium`, `high` | `analytical_feature.rvol_conf` (and any feed-quality flag) | Generalizes the current `rvol_conf` (`low`/`high`). |
| `Feed` | `iex`, `sip`, `delayed`, `eod` (extensible) | `market_bar.feed`, `options_snapshot.feed`, `analytical_feature` provenance | Market-data provenance → confidence. |
| `Source` | `arctic_shift`, `pullpush`, `discord` (extensible) | `raw_post.source`, `raw_comment.source`, `mention` lineage | Ingestion tap. `arctic_shift` is the sole live tap in v0.0.1. |
| `WinLoss` | `win`, `loss`, `breakeven` | `post_classification.win_loss` | **Per-post only** — never aggregated (§1.6). Phase 4. |
| `CoverageScope` | `wsb_hot`, `screener_mover`, `both` (extensible: `watchlist`, `market_universe`) | `analytical_feature.coverage_scope`, `signal.coverage_scope` | **Why a ticker is in the market/signal layer.** `wsb_hot` = pulled because WSB-hot; `screener_mover` = pulled from a market-wide screener with no WSB heat (a STEALTH candidate); `both` = both. |
| `BucketScheme` | `hour_of_week`, `day_of_week`, `time_of_day`, `quarter_hour_of_week` (extensible) | `baseline.bucket_scheme` | The seasonality scheme; chosen per `resolution` to trade seasonality detail against warmup speed (§7). |
| `OptionRight` | `call`, `put` | `options_contract.right` | Contract type. |
| `Flair` | `DD`, `YOLO`, `Gain`, `Loss`, `News`, `Discussion`, `Meme`, … | `mention.flair`, `flair_counts` keys | **Open set** (sub admins add flairs) → typed `Text`, with these as the *known* members. Do not hard-CHECK. |

---

## 5. Entities

Each entity below lists its **grain** (what one row/document represents), **natural key**,
**relationships**, and **lifecycle**. Field-level definitions live in
[`data-dictionary.md`](./data-dictionary.md); the machine contract in [`schema/`](./schema/).

> **Naming convention.** Entities are named **singular** (`mention`, `empirical_feature`). A physical
> store may pluralize collection/table names by local convention (the current DuckDB uses
> `mentions`, `empirical_features`, …); that is a binding choice, not part of the logical model.

### 5.1 Reference dimensions

#### `instrument`
- **Grain:** one tradable symbol in the universe.
- **Natural key:** `symbol` (`Symbol`).
- **Attributes:** `symbol`, `name` (raw vendor name), `asset_class` (equity/etf — extensible),
  `is_etf`, `is_ambiguous` (a real ticker that is also a common word, e.g. `DRAM` — gates extraction),
  `listing_status`, `first_seen`, `last_refreshed`.
- **Relationships:** referenced by `mention.ticker`, `empirical_feature.ticker`,
  `analytical_feature.ticker`, `signal.ticker`, `market_mover.symbol`, `baseline.ticker`.
- **Lifecycle:** **supersedes** the current `ticker_names` table (which is just `{symbol, name}`). The
  whitelist universe + ambiguous flag currently live in gitignored files (`whitelist/symbols.txt`,
  `whitelist/ambiguous.txt`); the new repo should promote them into this dimension.

#### `author` *(Phase 4)*
- **Grain:** one Reddit account observed mentioning a ticker.
- **Natural key:** `username` (`Id`).
- **Attributes:** `username`, `account_created` (`Instant`), `karma` (`Count`), `author_cred`
  (`UnitInterval` — tenure/karma weight), `is_bot` (`Boolean`), `first_seen`, `last_seen`.
- **Relationships:** referenced by `mention.author`, `raw_post.author`, `raw_comment.author`.
- **Lifecycle:** Phase 4 (trust/`astroturf`/`author_cred`). Today authors are bare strings on events;
  bots are filtered at ingestion via a config list, not a dimension.

### 5.2 Raw event streams (append-only source of truth)

#### `content_item` — *the generalized community message (Reddit + Discord)*
- **Grain:** one community content object — a Reddit post, a Reddit comment, **or** a Discord message.
- **Natural key:** `(platform, id)` (`id` is the platform-native id; pairing with `platform` keeps it
  globally unique across sources).
- **Attributes:** `platform` (`Platform`), `kind` (`ContentKind`), `id` (`Id`), `created_utc` (event
  time), `author`, `container` (the topical bucket — subreddit on Reddit, channel on Discord),
  `root_id` (the thread/submission this belongs to), `parent_id` (immediate parent for replies),
  `title` (post-only), `body` (selftext / comment body / message text), `flair` (Reddit-only label),
  `roles` (Discord author roles — a `Map`/list), `score` (Reddit upvotes — **settled**),
  `reaction_counts` (Discord emoji reactions — **live**; `Map`), `num_replies`/`num_comments`,
  `retrieved_on` (observation time), `source` (`Source` — the specific tap).
- **Field applicability** (which fields are meaningful per `(platform, kind)`):

  | Field | reddit·post | reddit·comment | discord·message |
  |---|:---:|:---:|:---:|
  | `title` | ✓ | — | — |
  | `body` | ✓ (selftext) | ✓ | ✓ |
  | `container` | subreddit | subreddit | channel |
  | `flair` | ✓ | (rare) | — |
  | `roles` | — | — | ✓ (author server roles) |
  | `score` (upvotes, settled) | ✓ | ✓ | — |
  | `reaction_counts` (live) | — | — | ✓ |
  | `root_id` / `parent_id` | self / — | post / parent comment | thread / replied msg |

- **Mutability:** identity is immutable; **engagement is re-fetched** — Reddit `score`/`num_comments`
  settle slowly (~36 h), Discord `reaction_counts` are live. Settled engagement is reconciled into
  `engagement_settled`.
- **Relationships:** self-referential thread tree (`root_id`/`parent_id`); produces 0..N `mention`;
  N:1 → `author`.
- **Lifecycle:** the current v0.0.1 splits this into Reddit-only `raw_posts` + `raw_comments`
  (no Discord, no `roles`/`reaction_counts`). The canonical model **unifies them** so Discord ingestion
  is a new `platform` value, not new entities (see [§12](#12-lifecycle--mapping-to-the-current-v001-implementation)).

#### `mention` — *the atomic empirical event*
- **Grain:** **one (ticker × content_item) reference** — a single extracted ticker occurrence in a
  single post/comment/message. *One item = one mention per ticker even if the ticker repeats in the
  text* (the de-dup grain). **This is the time-series source of truth for all empirical features.**
- **Natural key:** `(platform, thing_id, ticker)`.
- **Attributes:** `ticker` (`Symbol`), `platform` (`Platform` — denormalized from the item for
  per-source rollups), `thing_id` (`Id`), `thing_type` (`ContentKind`), `created_utc` (event time —
  inherited from the item), `author`, `flair` (Reddit) / `container` (Discord channel), `direction`,
  `weight` (`Ratio`, default `1.0`).
- **`weight` — per-mention ticker weighting.** v0.0.1 grain is **binary** (`weight = 1.0`): a 20-ticker
  watchlist post contributes equally to all 20, which over-counts incidental mentions. `weight` is the
  hook to fix this without a re-model — e.g. `1/n` for an `n`-ticker item, or a primary-ticker boost
  from the LLM classifier (`post_classification.ticker`, Phase 4). Aggregations sum `weight`, not raw
  rows, so `mentions`/`sov` become weighted once `weight ≠ 1`.
- **Relationships:** N:1 → `instrument` (`ticker`); N:1 → the producing `content_item` (`(platform,
  thing_id)`); N:1 → `author`. Rolled up into `empirical_feature`.
- **Invariant:** identity is fixed (first-seen wins on conflict). `platform` is carried so SoV and all
  momentum can be computed **per-source** (Reddit-only, Discord-only) *and* **combined** — the basis
  of cross-platform signals ([signals-catalog.md](./signals-catalog.md)).

#### `market_bar` *(defined; not written in v0.0.1)*
- **Grain:** one OHLCV price bar for an instrument at a timestamp.
- **Natural key:** `(ticker, bar_ts)`.
- **Attributes:** `ticker`, `bar_ts` (`Instant`), `open`, `high`, `low`, `close`, `volume`, `vwap`,
  `feed` (`Feed`), `as_of` (`Instant`).
- **Relationships:** N:1 → `instrument`; rolled up into `analytical_feature`.

#### `options_contract` — *the raw chain (per strike × expiry × right)*
- **Grain:** one options **contract** observation for an instrument at a snapshot time — the
  **contract-level raw** from which every options aggregate is derived.
- **Natural key:** `(ticker, snap_ts, expiry, strike, right)`.
- **Attributes:** `ticker`, `snap_ts` (`Instant`), `expiry` (`Instant`), `strike` (`Money`), `right`
  (`OptionRight`), `volume` (`Count`), `open_interest` (`Count`), `iv` (`Real`), `delta`/`gamma`/`vega`/
  `theta` (`Real`, Greeks), `feed`, `as_of`.
- **Relationships:** N:1 → `instrument`; rolled up into `options_snapshot`.
- **Why raw, not just the aggregate:** entropy `breadth`, `uoa` (`vol/OI`), `iv_skew`, and any future
  per-strike feature **cannot be recomputed** from a pre-aggregated chain snapshot. Keeping the
  contract grain makes the options features re-derivable and tunable. When a feed only exposes chain
  aggregates (degraded), `options_snapshot` may be ingested directly and `options_contract` left empty.

#### `options_snapshot` — *per-(ticker, snapshot) chain aggregate (derived; co-located with its raw source)*
- **Grain:** one options-chain aggregate for an instrument at a timestamp.
- **Natural key:** `(ticker, snap_ts)`.
- **Attributes:** `ticker`, `snap_ts` (`Instant`), `call_vol`, `put_vol`, `pcr`, `call_oi`, `put_oi`,
  `atm_iv`, `iv_rank`, `iv_skew`, `uoa` (`Ratio` vol/OI), `breadth_strikes`, `breadth_expiries`,
  `breadth_entropy`, `feed`, `as_of`.
- **Relationships:** **derived from `options_contract`** (aggregate over the chain); feeds
  `analytical_feature` (options increment, Phase 2→4). Regenerable when `options_contract` is present.

#### `market_mover` — *screener capture (market-wide read)*
- **Grain:** one screener row at a capture timestamp (a most-active / gainer / loser entry).
- **Natural key:** `(ts, kind, rank)`.
- **Attributes:** `ts` (`Instant`), `kind` (`MoverKind`), `rank` (`Count`, 1=top), `symbol`, `price`
  (`Money`), `percent_change` (`Real`), `volume` (`Count`).
- **Relationships:** N:1 → `instrument` (`symbol`). The bounded market-wide read that powers STEALTH
  (screener movers ∖ WSB-hot — Phase 3 detection).

#### `ingestion_run` — *coverage / provenance of each raw pull*
- **Grain:** one ingestion pass per source (and content kind) at a poll time.
- **Natural key:** `(source, kind, poll_ts)`.
- **Attributes:** `source` (`Source`), `kind` (`ContentKind` / `market` — what was pulled), `poll_ts`
  (`Instant`), `cursor` (`Text` — pagination/since token), `oldest_item`/`newest_item` (`Instant` — the
  event-time span fetched), `items_fetched` (`Count`), `pages` (`Count`), `capped` (`Boolean` — hit the
  pagination cap ⇒ **the window may be incomplete**), `lag_seconds` (`Duration`, s — newest item vs
  wall clock), `status` (`Text`/enum — ok / stale / down).
- **Relationships:** none (provenance metadata). **Why it's first-class:** a near-live radar's `sov`
  denominator is only as honest as ingest completeness — a `capped` peak-hour Daily-Discussion pull
  silently biases every `sov`. Consumers/quality checks read `ingestion_run` to know when a window's
  counts are trustworthy (it is the structured form of the heartbeat + the `[CAP]` canary in
  [architecture §3](./architecture.md)).

### 5.3 Derived rollups (regenerable; grain = `instrument × window_start × resolution`)

> **Half-open window convention.** A cell covers `[window_start, window_start + len(resolution))`.
> `window_start` is clock-aligned to the resolution. The same `(ticker, window_start)` exists once
> *per resolution*.

#### `empirical_feature` — *WSB-side cell*
- **Grain:** `(ticker, window_start, resolution)`.
- **Natural key:** `(ticker, window_start, resolution)`.
- **Attributes (Family A — see dictionary for full defs):** `mentions`, `authors`, `sov`, `velocity`,
  `accel`, `rank`, `rank_delta`, `z`, `net_dir`, `dd_count`, `flair_counts` (`Map`), `yolo_usd`
  *(P4)*, `astroturf` *(P4)*, `baseline_status`, `h_e`, `total_window_mentions` (`Count`), `quiet`
  (`Boolean`), plus `computed_at` (observation time).
- **`quiet`/`total_window_mentions` live on the cell, not just the snapshot.** `total_window_mentions` =
  Σ mentions across all tickers in this `(window_start, resolution)`; `quiet = total_window_mentions <
  min_window_mentions` — a **window-trust flag** every consumer (dashboard, alerts, API) needs, so it
  belongs on the cell rather than only in the presentation snapshot.
- **Relationships:** aggregated from `mention`; joined to `analytical_feature` and `signal` on the
  grain (full outer — see those entities); reads `baseline` for `z`.
- **Lifecycle note:** `rank`/`rank_delta` are **computed transiently** today (used inside `H_e`, only
  persisted via the unwritten `signals` table). The canonical model **persists them on the cell**.
- **Cross-platform extension:** the cell is the **combined** community view by default. An optional
  `platform` discriminator (`reddit` / `discord`) extends the natural key to materialize **per-source**
  cells alongside the combined one — the basis for cross-platform SoV and Discord→Reddit lead-lag
  ([signals-catalog §5](./signals-catalog.md)). Absent Discord, only the `reddit` (and combined) cells
  exist; no schema change when Discord arrives.

#### `analytical_feature` — *market-side cell*
- **Grain:** `(ticker, window_start, resolution)`.
- **Natural key:** `(ticker, window_start, resolution)`.
- **Attributes (Family B):** `ret`, `gap` *(P4)*, `range` *(P4)*, `realized_vol` *(P4)*, `rvol`,
  `rvol_conf` (`Confidence`), `pcr`, `iv_rank`, `iv_skew` *(P4)*, `uoa` *(P4)*, `breadth`, `h_m`,
  `coverage_scope` (`CoverageScope`), `feed` (provenance), `as_of` (observation time).
- **`ret` is window-aligned** (`close(W)/close(W−1) − 1` at this resolution); v0.0.1 approximates it
  with a day-to-date return until intraday bars are stored — see [dictionary §4.1](./data-dictionary.md).
- **Relationships:** aggregated from `market_bar` + `options_snapshot`; joined to `empirical_feature`
  on the grain. **NOT a subset of `empirical_feature`** — a cell exists for any ticker the funnel
  fetched, i.e. **WSB-hot top-N (`coverage_scope=wsb_hot`) ∪ screener movers
  (`coverage_scope=screener_mover`)**. A `screener_mover` cell with no matching empirical row is a
  STEALTH candidate (market moving, WSB silent).

#### `signal` — *the product cell (Phase 3)*
- **Grain:** `(ticker, window_start, resolution)`.
- **Natural key:** `(ticker, window_start, resolution)`.
- **Attributes:** `h_e` (`UnitInterval`, **null when no empirical row** — a STEALTH cell),
  `h_m` (null when no market row), `divergence` (`SignedUnit`, `h_e − h_m`, **null unless both heats
  present**), `quadrant` (`Quadrant`), `coverage_scope` (`CoverageScope`), `rank`, `rank_delta`,
  `lead_lag_hrs` (`Duration`, hours; signed), `computed_at`.
- **Relationships:** **full outer join** of `empirical_feature` + `analytical_feature` on the grain —
  a `signal` cell exists if **either** side does. This is what lets STEALTH (analytical-only) and HYPE
  (empirical-heavy) both be representable.
- **Quadrant with a missing axis:** `quadrant` is a function of `(h_e, h_m)` vs each one's rolling
  median; a **missing heat is treated as "quiet" on that axis** (absent `h_e` ⇒ WSB-quiet ⇒ STEALTH/
  QUIET; absent `h_m` ⇒ market-quiet ⇒ HYPE/QUIET). `divergence` stays `null` when an axis is missing
  (you can't subtract an unknown), but the quadrant badge is still assigned.
- **Lifecycle:** schema exists in v0.0.1 but is **not populated**; this is the v0.0.2 product layer.

### 5.4 Baselines & enrichment

#### `baseline` — *seasonal reference for `z`*
- **Grain:** `(ticker, resolution, bucket_scheme, seasonal_bucket)`.
- **Natural key:** the full grain above.
- **Attributes:** `ticker`, `resolution`, `bucket_scheme` (e.g. `hour_of_week`; for `1d` it would be
  `day_of_week`), `seasonal_bucket` (`SeasonalBucket`), `mention_mean` (`Real`), `mention_std`
  (`Real`), `sample_count` (`Count`), `status` (`BaselineStatus`), `vol_mean` (`Real`, market analog),
  `updated_at`.
- **Relationships:** rolling stats derived from `empirical_feature` history; read by the aggregator to
  compute `z`/`baseline_status`.
- **Lifecycle note (correctness):** the current code stores a `baselines` table but **does not use it**
  — it recomputes baselines on the fly from `empirical_features` each cycle. The canonical model treats
  `baseline` as a **materialized rollup** with an explicit `bucket_scheme` and `resolution` (the
  current implicit `hour_of_week`/`1h` is one instance). Generalizing the bucket scheme per resolution
  is required so `z` is meaningful at `15m`/`1d` too.
- **`bucket_scheme` is chosen per resolution to balance seasonality detail vs warmup speed.** A scheme
  with *B* buckets needs ≈ `B × min_samples_ready` windows before `z` is `ready`. `hour_of_week` (168)
  on `1h` warms in ~8 weeks; `quarter_hour_of_week` (672) on `15m` would take **months** — so fine
  resolutions should use a **coarser** scheme like `time_of_day` (96 quarter-hours of the *day*, drops
  day-of-week seasonality) to reach `ready` in days, not months. `1d` uses `day_of_week` (7). Backfill
  (Phase 4) is the real accelerant; until then, the scheme choice is the lever.

#### `engagement_settled` *(Phase 4)*
- **Grain:** one settled-engagement reconciliation for a `content_item`. On Reddit, captured **>36 h**
  after creation (when scraper `score`/`num_comments` stabilize); on Discord, `reaction_counts` are
  live so the "settled" point is far sooner.
- **Natural key:** `(platform, thing_id)` (latest settled snapshot) — or add `as_of` to keep history.
- **Attributes:** `platform`, `thing_id`, `thing_type`, `ticker` (optional convenience), `upvotes`
  (Reddit), `reaction_total` (Discord), `num_comments`/`num_replies`, `awards`, `eng_per_mention`
  (`Ratio`), `settled_at` (`Instant`).
- **Relationships:** N:1 → `content_item`. Feeds a **separate *settled* `H_e`** for tuning/backtests —
  **never the live `H_e`** (Reddit scrapers report engagement wrong for ~36 h; Discord reactions are
  the live exception, catalogued separately).

#### `post_classification` *(Phase 4 — survivorship firewall)*
- **Grain:** **one `content_item`** (LLM classifier output; typically Reddit DD/YOLO posts).
- **Natural key:** `(platform, thing_id)`.
- **Attributes:** `platform`, `thing_id`, `ticker` (the item's primary ticker, if any),
  `is_option_play` (`Boolean`), `llm_stance` (`Direction`), `yolo_usd` (`Money`), `reported_pnl`
  (`Money`), `win_loss` (`WinLoss`), `model`, `classified_at`.
- **Relationships:** 1:1 → `content_item`. **HARD CONSTRAINT:** there is **no aggregation path** from
  this entity to any per-ticker rate. Outcome data is per-item evidence only ([§1.6](#1-modeling-principles-non-negotiable)).

---

## 6. Relationships at a glance

| From | Cardinality | To | Via | Kind |
|---|---|---|---|---|
| `content_item` | 1 : N | `content_item` | `parent_id` / `root_id` | self thread tree (soft; parent may be un-ingested) |
| `content_item` | 1 : N | `mention` | `mention.(platform, thing_id)` (+ `thing_type`) | polymorphic produce |
| `instrument` | 1 : N | `mention`, `*_feature`, `signal`, `market_mover` | `symbol` / `ticker` | FK (extractor validates `ticker ∈ instrument`) |
| `author` | 1 : N | `mention`, `content_item` | `username` | FK (P4) |
| `mention` | N : 1 | `empirical_feature` | aggregate over `[window_start, +resolution)` | rollup (per-platform + combined) |
| `options_contract` | N : 1 | `options_snapshot` | aggregate over the chain at `snap_ts` | rollup |
| `market_bar` + `options_snapshot` | N : 1 | `analytical_feature` | aggregate over window | rollup |
| `empirical_feature` | 0..1 : 0..1 | `analytical_feature` | `(ticker, window_start, resolution)` | grain join (**either side may be absent** — STEALTH = analytical-only) |
| `empirical_feature` ⟗ `analytical_feature` | → 1 | `signal` | `(ticker, window_start, resolution)` | **full outer join** → product (carries `coverage_scope`) |
| `empirical_feature` (history) | N : 1 | `baseline` | rolling stats per `(ticker, resolution, bucket_scheme, seasonal_bucket)` | rollup |
| `ingestion_run` | — | — | provenance/coverage of raw pulls | metadata (no FK) |
| `content_item` | 1 : 1 | `post_classification` | `(platform, thing_id)` | enrichment (P4, no aggregation) |
| `content_item` | 1 : 1 | `engagement_settled` | `(platform, thing_id)` | reconciliation (P4) |

---

## 7. The multi-resolution rollup model

The single most important structural decision. **Raw `mention` events are resolution-free**; the
`resolution` dimension is introduced **only in the derived cells**.

- **`window_start` is clock-aligned** to the resolution: `window_start = floor(event_time / len) * len`,
  where `len(15m)=900s`, `len(1h)=3600s`, `len(1d)=86400s` (UTC; session-aware variants are a Phase-4
  refinement, see [signal-framework §7](./signal-framework.md)).
- **Each resolution is an independent rollup** of the same raw stream. The same minute of chatter
  contributes to its `15m`, `1h`, and `1d` cells simultaneously. They are **not** derived from each
  other (a `1d` cell is aggregated from raw mentions, **not** from 24 `1h` cells — `sov` denominators
  and distinct-author counts don't sum).
- **`sov` is always within-window-within-resolution:** `sov(T,W,r) = Σ weight(T,W,r) / Σ_t Σ weight(t,W,r)`
  (mention `weight` defaults to 1 ⇒ a plain count today; see [mention](#mention--the-atomic-empirical-event)).
- **Combined (cross-platform) SoV is a weighted blend of per-source SoV, NOT a pooled count.** Each
  platform has its **own denominator** — `sov_reddit = mentions(T)/Σ Reddit mentions`, `sov_discord =
  mentions(T)/Σ Discord mentions` — computed on the per-platform cells. The combined community attention
  is `sov_combined = Σ_p platform_weight[p] · sov_p` (weights config; sum to 1). **Do not pool raw counts
  across platforms:** Discord's far higher message volume would swamp Reddit, and the two have no common
  unit (a Discord one-liner ≠ a Reddit DD post). Per-item `weight` (above) is the within-platform refiner;
  `platform_weight` is the across-platform one. Absent a platform, its term drops and the rest renormalize.
- **Momentum is within-resolution:** `velocity(T,W,r) = mentions(T,W,r) − mentions(T,W−1,r)` where
  `W−1` is the previous window *of the same resolution*. `null` if that predecessor cell doesn't exist.
- **Baselines are per-resolution with a seasonality chosen for warmup speed** (`bucket_scheme`):
  `1h` → `hour_of_week` (168 buckets, ~8-week warmup); `1d` → `day_of_week` (7); `15m` → **`time_of_day`
  (96 buckets)** rather than `quarter_hour_of_week` (672) so `z` reaches `ready` in days not months
  (trades away day-of-week seasonality at fine resolution — see [§5.4](#baseline--seasonal-reference-for-z)).
- **`z` compares like-with-like:** a cell's `mentions` vs the `baseline` for *its* `(ticker, resolution,
  bucket_scheme, seasonal_bucket)`.

**Late-arriving data.** A cell is **re-aggregated within a bounded lateness horizon** (config; the
current code re-runs the open window + finalizes `W−1` each cycle). An event whose `created_utc` falls
in an already-closed window inside the horizon triggers a **recompute of that window's cell**; past the
horizon it is late-bucketed (or dropped) and flagged in `ingestion_run` — never folded into the current
window, which would corrupt boundary `velocity`/`accel`.

**Realization mapping.** The simple time-bucket rollups (`empirical_feature`, `analytical_feature`) map
onto **TimescaleDB continuous aggregates** — one per resolution over the `mention`/`market_bar`
hypertables — or **rollup collections** in a document store. The **seasonal `baseline`** does *not*:
calendar-part grouping (`hour-of-week`, `day-of-week`) isn't expressible as a standard `time_bucket`
continuous aggregate, so realize it as a **scheduled materialized view / refresh job**. A plain
materialized table refreshed by the radar each cycle is the portable fallback for everything. Adding
`5m` later = one new rollup definition + one new `Resolution` member; no entity or attribute changes.

---

## 8. Storage realization

The logical model is invariant; only the physical clustering differs. Two reference bindings:

### 8.1 RDBMS — Postgres + TimescaleDB (the stated direction)
- **Raw streams → hypertables** partitioned on their event-time (`mention.created_utc`,
  `market_bar.bar_ts`). High-volume, append-mostly, time-partitioned.
- **Derived cells → continuous aggregates** (or plain tables refreshed by the radar), one logical
  rollup per `resolution`. The `(ticker, window_start, resolution)` PK becomes the natural unique index.
  **Caveat:** continuous aggregates fit fixed `time_bucket` rollups; the seasonal `baseline` (grouped by
  a calendar part) needs a **scheduled materialized view / refresh job**, and complex blends may need a
  plain materialized table — don't assume every rollup is a CAgg. `signal` is a **full outer join** of
  the two feature rollups (so STEALTH analytical-only cells survive), refreshed per cycle.
- **`flair_counts`:** `JSONB` column **or** a normalized `flair_breakdown(ticker, window_start,
  resolution, flair, count)` child table — both satisfy the `Map<Symbol→Count>` logical type. Prefer
  the child table if you query "all tickers with ≥N DD posts"; prefer JSONB if it's display-only.
- **Reference dims → ordinary tables** with FKs from the event/feature streams.
- **Instants:** `timestamptz` (recommended) — but epoch-`bigint` is a valid binding if matching the
  current store. Pick one project-wide.
- **Money:** `numeric` — never `double precision`.

### 8.2 Document store
- **One collection per raw stream** (`mentions`, `content_items`, `market_bars`, …) — append-only,
  time-bucketed shard key; `content_items` shards by `(platform, created_utc)`.
- **The natural aggregate document is the feature cell**, keyed by `{ticker, window_start, resolution}`,
  **embedding** the three families that share that grain:
  ```jsonc
  { "_id": "AVGO|1717430400|1h",
    "ticker": "AVGO", "window_start": 1717430400, "resolution": "1h",
    "empirical":  { "mentions": 412, "authors": 88, "sov": 0.41, "velocity": 120, "accel": 35,
                    "rank": 1, "rank_delta": 0, "z": null, "net_dir": 0.6, "dd_count": 2,
                    "flair_counts": { "DD": 2, "YOLO": 14 }, "baseline_status": "cold", "h_e": 0.83,
                    "total_window_mentions": 1005, "quiet": false },
    "analytical": { "ret": 0.031, "rvol": 1.4, "rvol_conf": "low", "h_m": 0.52, "feed": "iex",
                    "coverage_scope": "wsb_hot" },
    "signal":     { "divergence": 0.31, "quadrant": "hype", "coverage_scope": "wsb_hot", "lead_lag_hrs": null },
    "computed_at": 1717434000 }
  ```
  `analytical`/`signal` are **absent (not null-filled)** when the ticker had no market read. A **STEALTH**
  document is the mirror image — `analytical`/`signal` present (`coverage_scope: "screener_mover"`) with
  `empirical` **absent** and `signal.h_e: null` — the document-store equivalent of the full outer join.
- **Embed vs reference:** embed same-grain feature families (above) and the small `flair_counts` map;
  **reference** (don't embed) the high-volume raw events and the `instrument`/`author` dimensions.

---

## 9. Identity, keys & provenance

- **Natural keys throughout** (no surrogate auto-IDs in the logical model): `instrument.symbol`,
  `content_item.(platform, id)`, `mention.(platform, thing_id, ticker)`,
  `(feature.ticker, window_start, resolution)`. An implementation may add
  a surrogate PK for convenience, but the natural key remains the uniqueness contract.
- **Provenance rides with market & raw data:** `source` (ingestion tap), `feed` (market feed),
  `as_of` (feed time), `retrieved_on` (ingestion time), `computed_at` (derivation time). These let a
  consumer answer "how stale was the price when this mention spiked?" — a first-class question
  ([architecture §2.5 "as-of tagging"](./architecture.md)).
- **Bitemporality (explicit stance):** `event_time` fields (`created_utc`, `window_start`, `bar_ts`) vs
  `observation_time` fields (`retrieved_on`, `as_of`, `computed_at`, `settled_at`). The decision:
  - **Raw events** are append-only; **event-time identity is never rewritten**. Mutable engagement
    (`score`, `reaction_counts`) is **overwritten in place** to the latest observed snapshot — full
    engagement *history* is captured only at the reconciled checkpoint (`engagement_settled`, keyed with
    `as_of` if you opt to keep versions), not by versioning every re-fetch.
  - **Derived cells** hold the **latest computed value** (overwritten on recompute), because they are
    regenerable from raw. They are **not** bitemporally versioned.
  - **Point-in-time radar state** ("what did the board show at 14:00?") is preserved by the **immutable
    snapshot/history exports** (the JSON snapshot + `history.parquet` today), *not* by versioning cells.
  - If true as-was-known-at-T audit of derived cells is ever needed, add an explicit `valid_from`/
    `valid_to` versioning layer then — it is deliberately out of scope now (cost > value for a radar).
- **`x-requires` is intra-entity documentation, not the full dependency graph.** The `x-requires` /
  `x-mode` / `x-sources` annotations on schema fields list a field's *same-entity* inputs and degradation
  mode for readability. They are **not** a transitive, cross-entity execution graph (e.g. `sov` → `mention`
  → `content_item` ingest; `z` → `baseline.status`). The **authoritative** computability/degradation
  graph is the [signals-catalog §4 degradation matrix](./signals-catalog.md); a runtime "compute-what-you-can"
  engine should drive off that, using the annotations only as inline hints (cross-entity inputs are tagged
  `x-requires-source` where they cross an entity boundary).

---

## 10. Confidence & null discipline (recap, because it's where signals rot)

- **`null` ≠ `0`.** See [§1.5](#1-modeling-principles-non-negotiable). The dictionary states each
  field's null trigger. Aggregations must use null-aware reducers (a `null` velocity is *excluded*, not
  treated as `0`).
- **Confidence flags travel with the value:** `rvol_conf` (and any future feed-quality flag) is
  `Confidence`, set by `feed`. Free IEX volume ⇒ `rvol_conf = low`. Consumers must not treat a
  low-confidence value as ground truth ([architecture §2.5](./architecture.md)).
- **`baseline_status` gates `z`:** `z` may be non-null while `baseline_status` is `warming`; consumers
  must check status before trusting/weighting it. In `H_e`, `z`'s weight is **0 unless `ready`**.

---

## 11. Invariants & constraints

Machine-checkable assertions the model must always satisfy (good CI / DB CHECK candidates):

1. `0 ≤ sov ≤ 1`; within a `(window_start, resolution)`, `Σ_t sov(t) ≈ 1` (float tolerance).
2. `0 ≤ h_e ≤ 1`, `0 ≤ h_m ≤ 1`, `0 ≤ iv_rank ≤ 1`, `0 ≤ breadth_entropy ≤ 1` (`UnitInterval`).
3. `−1 ≤ net_dir ≤ +1` (`SignedUnit`).
4. `rvol ≥ 0`, `pcr ≥ 0` (`Ratio`).
5. `mentions ≥ authors ≥ 1` on any persisted empirical cell; `mentions ≥ dd_count ≥ 0` **when `dd_count`
   is non-null** (`dd_count`/`flair_counts` are `null` on a `reddit`-absent cell — §1.5, not `0`).
6. `velocity`, `accel`, `z` are **`null` or real** — never the integer `0` as a stand-in for "no prior".
7. Every `mention.ticker` ∈ `instrument.symbol` (extractor validates against the whitelist).
8. `mention` identity `(platform, thing_id, ticker)` is unique and immutable (first-seen wins).
9. Feature/signal grain `(ticker, window_start, resolution)` is unique per entity.
10. A `signal` cell exists iff an `empirical_feature` **or** an `analytical_feature` row exists on its
    grain (**full outer join**). `analytical_feature`/`signal` are **NOT** a subset of `empirical_feature`
    — a `coverage_scope = screener_mover` cell legitimately has **no** empirical row (a STEALTH candidate).
    Every `analytical_feature`/`signal` cell carries a `coverage_scope` recording why it was pulled.
11. `divergence = h_e − h_m` exactly **when both are present**, else `null`. `quadrant` is a pure
    function of `(h_e, h_m)` vs their rolling medians, treating a **missing heat as "quiet" on that
    axis** (so a STEALTH cell with null `h_e` still gets a badge).
12. **No query aggregates `post_classification` / `engagement_settled` outcome fields to a per-ticker
    rate.** (Enforced by review + the absence of a rollup entity; §1.6.)
13. A cell's `quiet = (total_window_mentions < min_window_mentions)`; consumers must treat a `quiet`
    cell's `H_e`/rank as low-confidence (off-hours single-mention noise).
14. Any window/cell whose `ingestion_run` is `capped` (incomplete pull) has **untrustworthy `sov`
    denominators** and should be flagged, not silently ranked.

---

## 12. Lifecycle & mapping to the current v0.0.1 implementation

Each field in the dictionary carries a **lifecycle tag**; here is the entity-level summary and the
**delta vs the current DuckDB schema** (`wsb_signals/db.py`), so nothing is lost in migration.

| Entity | Status today | Notes / delta to apply in the new repo |
|---|---|---|
| `content_item` | **partial** — exists as Reddit-only `raw_posts` + `raw_comments`; no Discord | Unify into one `content_item` with `platform`/`kind`; add `container`, `roles`, `reaction_counts`. Discord then drops in as a new `platform`, not new tables. |
| `mention` | **live** (written each poll) | The empirical source of truth — keep append-only. **Add `platform`** so SoV/momentum compute per-source and combined. |
| `instrument` | **partial** — only `ticker_names{symbol,name}` exists; universe + ambiguous flag are gitignored files | Promote whitelist + `ambiguous.txt` into this dimension; add `asset_class`/`is_etf`/`is_ambiguous`. |
| `empirical_feature` | **live** | Add the `resolution` dimension to the key; **persist `rank`/`rank_delta`** (today transient). |
| `analytical_feature` | **live (stock overlay)** — `ret`, `rvol`, `rvol_conf`, `h_m`; `pcr`/`iv_rank`/`breadth` columns exist unfilled | Add `resolution` + **`coverage_scope`**; make it **independent of `empirical_feature`** (screener movers, not just WSB-hot); switch `ret` to window-aligned; fill options fields in Phase 2/4. |
| `market_mover` | **live** (screener capture) | Feeds `coverage_scope = screener_mover` cells; STEALTH *detection* still pending (Phase 3). |
| `market_bar`, `options_snapshot` | **defined, not written** | Wire the funnel writes; today the overlay reads snapshots ad-hoc without persisting bars. `options_snapshot` becomes a **derived aggregate of `options_contract`**. |
| `options_contract` | **not modeled** | New **raw** contract-level chain (strike×expiry×right) so `breadth`/`uoa`/`iv_skew` are re-derivable; Phase 2/4. |
| `signal` | **defined, not written** | The v0.0.2 product layer; make it a **full outer join** (+`coverage_scope`) so STEALTH cells exist; `divergence` null when an axis is missing. |
| `baseline` | **defined, not used** — aggregator recomputes on the fly from `empirical_features` | Materialize it; add `resolution` + `bucket_scheme` (coarser for fine resolutions); this is a correctness gap, not just an optimization. |
| `ingestion_run` | **partial** — `wsb heartbeat` + the `[CAP]` warning exist but aren't persisted | Persist coverage/provenance per pull so `sov` denominators carry a trust flag. |
| `author` | **not modeled** — bare author strings + a bot stoplist | Phase 4 trust dimension (`author_cred`, `astroturf`). |
| `engagement_settled`, `post_classification` | **not modeled** | Phase 4; keep the survivorship firewall (§1.6). |

> **Transient-today fields to persist in the new model:** `rank`, `rank_delta` (computed inside the
> aggregator for `H_e` but only ever written to the unwritten `signals` table). The per-component
> normalized values (`sov_n`, `acc_n`, …) remain **transient by design** — they are a function of the
> stored raw components and the window, recomputable on demand, so they are *not* entities.
