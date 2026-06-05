# WSB Signals — Roadmap

> Phased build plan. **v0.0.1 (code) = Phase 0 → Phase 2** (SoV trending radar + market overlay,
> minimal Streamlit). **v0.0.2 = Phase 3** (Attention×Action: divergence quadrants, lead-lag,
> alerts). Phases gate on exit criteria; don't skip Phase 0.
>
> **Version state (2026-06-05):** **v0.0.1 is FROZEN** (tagged; Python + DuckDB + Streamlit) — the
> parity **oracle**, not active code. **Active development is v2 — a full-stack TypeScript rewrite** of
> the whole stack; the v0.0.2 product (divergence/quadrants/STEALTH/lead-lag) is built **within v2**.
> Authoritative: [`design/v2-plan.md`](./design/v2-plan.md) + [`design/v2-porting-spec.md`](./design/v2-porting-spec.md).
> The phase descriptions below are **build history** for the frozen radar.

## Phase 0 — Feasibility & scaffolding ⛔ (gating)

The cheap experiments that decide whether the design holds. **Run before writing the live loop.**

- **0.1 — Arctic-Shift content-latency spike. ✅ DONE (2026-06-03).** `scripts/probe_reddit_taps.py`
  found Arctic-Shift **~real-time** (posts ~4 min, comments ~seconds old) and **PullPush frozen
  @2025-05-19** (globally — all-Reddit + r/AskReddit same cutoff). Latency gate **passed**;
  Arctic-Shift is the **sole live tap** → manage single-source risk
  ([reddit-data-access §4](./sources/reddit-data-access.md)).
- **0.2 — Alpaca smoke test. ✅ DONE (2026-06-03, `scripts/probe_alpaca.py`).** Stock snapshots ✅
  (200/min, real-time IEX); option snapshots ✅ (per-contract **volume** + **Greeks/IV on liquid
  strikes**); **screeners — most-actives + movers — ✅ work on the free tier → a bounded
  market-wide list.** That last one **changes the STEALTH story** (see Decisions). Whitelist asset
  list pulled (used by 0.4).
- **0.3 — Repo scaffold. ✅ DONE (2026-06-03).** `wsb_signals/` package on **uv** (Python ≥3.10):
  `config.toml` + `.env` loader (**Alpaca key never committed**), full **DuckDB** schema
  ([architecture §2.7](./design/architecture.md)), the `Source` interface + a **thin in-house
  `httpx`** Arctic-Shift client, logging, and a `wsb` CLI (`init-db`, `poll-once`). `poll-once`
  proved the slice live (config→source→extract→store): ~2k comments/h ingested, leaderboard sane
  (AVGO/SPY/MU/MRVL/NVDA). BAScraper stays an optional fallback.
- **0.4 — Ticker whitelist + WSB stoplist + extractor eval. ◑ CORE DONE (2026-06-03).** Whitelist
  built from Alpaca `assets` (12,697 listed tradable us_equity, non-OTC; `wsb build-whitelist`,
  gitignored, weekly refresh) and wired into the extractor with **stop → whitelist → ambiguous-gate
  → `$`-cashtag override** precedence. `wsb eval-extractor` reports the decision mix as a **precision
  proxy**: on a live 1 h sample the stoplist+whitelist drop ~53% of raw candidates and every rejected
  token is noise (PRINT/GOD/DOWN/…); accepted are all real tickers. The `DRAM`
  real-ticker-doubling-as-a-word case is now handled by an **ambiguous-token gate**
  (`whitelist/ambiguous.txt`, seeded with `DRAM`): a word-ticker is counted only with **trading
  context** (an options/position word or a `$`-cashtag in the same thing), else `ambig_no_context`.
  **Remaining (by design):** hand-labelled precision/recall (needs a human), and the broader
  per-token trading-context **weighting** / Massive `reference/tickers` alt universe (Phase 4) — the
  ambiguous gate is the bounded v0.0.1 version of it.
- **0.5 — Source freshness heartbeat. ✅ DONE (2026-06-03).** `wsb heartbeat` probes newest-item lag
  (posts + comments) and **exits non-zero** when staleness exceeds `heartbeat.max_staleness_seconds`
  (1 = stale, 2 = tap returned nothing → likely down) — cron/monitoring-friendly. Runbook in the
  README: on alarm the radar stops (no free fallback). The Phase-1 daemon will call it each cycle.
- **0.6 — DDT throughput spike.** Confirm a 5-min paginated poll captures the **full** peak-hour
  Daily-Discussion-Thread comment volume within rate limits (the PoC's `[CAP]` warning is the
  canary) — incomplete ingestion silently biases `sov` and per-post counts.

**Exit:** ✅ latency (0.1), ✅ scaffold (0.3), ◑ whitelist + extractor eval (0.4 core), ✅ heartbeat
(0.5), ✅ Alpaca endpoints (0.2) **done**. Remaining before v0.0.1 ships: throughput spike (0.6) +
the 0.4 hand-label pass + the Phase-2 options increment. (PullPush frozen → single-source risk,
actively monitored.)

## Phase 1 — Empirical pipeline (Reddit, taps-only) · v0.0.1 · ✅ DONE (2026-06-03)

- Arctic-Shift poll **every 5 min** (`wsb run`) via the in-house client. **Forward-only** (SoV needs
  no history; `z` warms forward). `classify.py` adds thing-level **direction** (bull/bear from
  options/position language; crude for multi-ticker posts — refine later).
- Windowed aggregator (`aggregate.py`) → `sov` (primary), `authors, velocity, accel, net_dir,
  dd_count, flair_counts`; baseline-gated `z` (cold/warming/ready, hour-of-week, forward-only) →
  **`H_e`**. Components are **max-normalized**, NOT percentile-ranked — percentile compressed the
  SoV leader's dominance and let `net_dir` override the primary signal (caught + fixed in testing).
- `wsb aggregate` (one-shot) / `wsb run` (loop; heartbeat each cycle) persist `empirical_features` +
  write `data/leaderboard.json`. `wsb dashboard` = minimal Streamlit board reading the **snapshot**
  (JSON, not DuckDB — sidesteps the single-writer lock).
- **Foundation hardening (2026-06-04).** Three quiet-window correctness fixes, with unit tests
  (`tests/`): (1) `velocity`/`accel` are **null when no prior window exists** (a cold start or a gap
  in the loop no longer reads as a breakout — they were silently `m`/`m`); a ticker merely absent
  from an *existing* prior window still gets `velocity = m`. (2) **Support shrink** — `H_e *=
  min(1, authors/heat.min_authors_full)` so a lone off-hours comment can't max-norm its way to the
  top (was scoring ~0.75 off 1 mention; now ~0.2). (3) Snapshot carries `total_mentions` + a
  **`quiet`** flag (`heat.min_window_mentions`) → the dashboard banners low-confidence windows.

**Exit:** ✅ running WSB-only trending leaderboard, sane vs the live sub (AVGO 41% SoV → #1).
**← v0.0.1 empirical milestone done.** Remaining for v0.0.1 ship: **Phase 2** (market overlay).

## Phase 2 — Analytical overlay (Alpaca) · v0.0.1 · ◑ stock overlay + screeners DONE (2026-06-03)

- **Stock overlay ✅:** hot-list multi-symbol `/v2/stocks/snapshots` (IEX) → `ret`, `rvol`
  (**low-conf on thin IEX**) → **`H_m`** (max-normalized, same rationale as `H_e`). `MarketData`
  funnel (`market/{base,alpaca}.py`) behind the interface; `wsb market` one-shot + run-loop overlay
  (best-effort, never kills the loop); dashboard gains `ret`/`rvol`/`H_m` columns.
- **Screeners ✅:** most-actives + movers captured each cycle → `market_movers` table + a snapshot
  `movers` section. This is the **bounded market-wide read** that makes STEALTH feasible (detection
  is Phase 3).
- **Options increment (next):** top-N chains → `pcr`, `atm_iv`, `breadth_strikes` enrich `H_m`
  (0.2 confirmed per-contract volume + Greeks/IV are available; needs chain pagination for both
  call+put legs). SPY/QQQ context proxies + per-feature as-of tagging land here too.

**Exit:** leaderboard + stock overlay + screener capture (live ✅). Options enrich `H_m` → **v0.0.1
ships.** 🎯

## Phase 3 — Signals (the product) · v0.0.2

- `H_e × H_m` → `divergence`, **quadrants** — Confirmed / Hype / Quiet, **plus Stealth** built from
  the **captured screener movers** (∖ WSB-hot, liquidity-filtered) — bounded to the loudest movers
  but real ([signal-framework §6.1](./design/signal-framework.md)).
- Log `H_e(t)`/`H_m(t)` series; rolling **lead-lag** estimate per ticker.
- Basic **alerts** (quadrant-flip; `uoa` + chatter spike coincidence); **per-ticker drill-down** in
  the dashboard.

- **History views ◑ DONE early (2026-06-04).** The `H_e(t)`/`H_m(t)` series are persisted hourly in
  DuckDB and exported lock-free to `data/history.parquet` each cycle (radar = single writer); the
  dashboard gained day/month tabs: **per-ticker drill-down** (H_e/H_m/mentions over time),
  **trending heatmap** (ticker × day), and a **daily rollup**. Forward-only → fills over time; no
  backfill (Phase 4/5). Still pending for v0.0.2: **divergence/quadrants**, **STEALTH detection**,
  **lead-lag** estimate, and **alerts** (the analytical product on top of the now-stored series).

**Exit:** the Attention × Action radar runs end-to-end on a ~5 min cadence. **← v0.0.2 done.**

## Phase 4 — Enrichment & hardening

- Engagement **reconciliation** (>36 h) → *settled* `H_e`; the **LLM post-classifier** (the deferred
  deep track: direction / P&L / win-loss / `is_option_play`, vision on screenshots — **per-post
  only, never aggregated to a per-ticker win rate**); entropy-based **options breadth**;
  `iv_skew` + Greeks; `astroturf` + `author_cred` (Arctic-Shift user data); **optional cold-start
  backfill** (dumps) to accelerate `z`; signal-weight tuning against observed outcomes.

## Phase 5 — Discord + research mode (deferred)

- **Discord source:** decide official `wsbverse` vs the larger unofficial server and resolve the
  ToS/access path ([wallstreetbets §9](./sources/wallstreetbets.md)) before any ingestion.
- **Research objective:** if the lead-lag looks real, build the historical backtest harness
  (Arctic-Shift dumps + market history) to quantify it properly — the honest "does WSB lead?"
  study the radar only hints at.

## Decisions (locked unless noted)
- ~~Arctic-Shift content latency~~ — **resolved 2026-06-03: ~real-time ✅**; PullPush frozen →
  single-source risk, mitigated by the Phase-0.5 freshness heartbeat **only** (no fallback tap —
  none exists free/working).
- **v0.0.1 scope = Phase 0→2**; **v0.0.2 = Phase 3** (decided 2026-06-03 review).
- ~~LLM post-classification track~~ — **deferred to Phase 4** (2026-06-03 review).
- **Normalization:** `sov`-primary; `z` gated on baseline readiness.
- **Cold-start:** forward-only, no backfill at launch (backfill is a Phase-4 option).
- **Cadence:** 5-min poll + recompute.
- **Language/tooling:** **Python + [uv]** (decided 2026-06-03; **Go evaluated and rejected** — the
  locked DuckDB + Polars + Streamlit stack is Python-native, and `uv run wsb …` removes the venv
  friction that motivated the question). No manual venv; `uv.lock` is committed.
- **Ingestion client:** thin in-house `httpx` (BAScraper = optional fallback).
- **Output:** minimal Streamlit board + JSON (per-ticker drill-down in v0.0.2).
- **Storage:** DuckDB + Parquet.
- **STEALTH quadrant:** **feasible (bounded) on free data** via the Alpaca screeners (most-actives
  + movers) — a market-wide read, bounded to the top-N loudest movers (penny / leveraged-ETF noise
  to filter). Screener data is **captured in Phase 2**; STEALTH *detection* (screener movers ∖
  WSB-hot, liquidity-filtered) is **Phase 3 / v0.0.2** (decided 2026-06-03, `probe_alpaca.py`).
  **Supersedes** the earlier "UNKNOWN until a paid market-wide feed".
- **Market-data:** **Alpaca free** for v0.0.1; SIP ($99) / Massive ($58) / IBKR are documented
  upgrades behind the funnel — still open when volume accuracy matters.
- Signal weights for `H_e`/`H_m` (default now; tune in Phase 4).
