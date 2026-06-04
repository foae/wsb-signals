# WSB Signals

A near-live **"trending radar"** for r/wallstreetbets: surface which stock tickers the WSB
community is piling into *right now*, and overlay real market data (price, volume, options) to
show whether the market is **confirming** the chatter or **diverging** from it.

> **Status:** v0.0.1 — **radar + market overlay run end-to-end (Phase 0–2 stock overlay done).**
> `uv run wsb run` polls Arctic-Shift every 5 min, computes the SoV-primary, baseline-gated **`H_e`**
> leaderboard, overlays Alpaca market data (`ret`/`rvol` → **`H_m`**) for the hot list, and captures
> the free screeners → DuckDB + a JSON snapshot; `uv run wsb dashboard` shows it in Streamlit.
> **Milestones:** `v0.0.1 = Phase 0→2` (radar + overlay; **options enrich `H_m`** to finish);
> `v0.0.2 = Phase 3` (divergence quadrants + STEALTH + lead-lag). See [`ROADMAP.md`](./ROADMAP.md).
>
> **This is observational/correlational research, not financial advice.** WSB *moves* the names it
> discusses (reflexivity), gain-posts are survivorship-biased, and the sub is a manipulation-prone
> environment. The system is built to *measure* the attention↔market relationship, not to predict
> it. See [Honest caveats](#honest-caveats).

## What it is

WSB Signals computes, per **(ticker, time-window)** cell, two comparable signal families and
studies their interaction:

- **Empirical signals** (what the *community* does) — from Reddit now, Discord later: mention
  volume & share-of-voice, momentum (velocity/acceleration/z-score), bet direction (calls vs
  puts), flair mix (DD/YOLO/Gain/Loss), conviction (DD count, YOLO $-size). → **WSB Heat `H_e`**.
- **Analytical signals** (what the *market* does) — price return, relative volume, options
  activity (put/call, IV, "matrix breadth"). → **Market Heat `H_m`**.

The product is **Attention × Action**: a leaderboard of hot tickers, each badged by quadrant —
**Confirmed** (chatter + market agree), **Hype** (loud, no market follow-through), **Stealth**
(market moving, WSB hasn't noticed), **Quiet** — plus a rolling **lead-lag** estimate. Full model:
[`design/signal-framework.md`](./design/signal-framework.md).

## Scope decisions (locked for v0.0.1)

| Decision | Choice | Consequence |
|---|---|---|
| **Objective** | Live trending radar (operational) | Near-live cadence; not a backtest engine (yet). |
| **Data horizon** | Forward-first | Collect from now; backfill only to seed baselines. |
| **Reddit access** | **Arctic-Shift** (verified live, sole working tap); **PullPush frozen @2025-05-19**; **Reddit API excluded** | No live upvote velocity → rank on **share-of-voice** (`z` gated on baseline readiness). Single-source risk on Arctic-Shift → **active freshness heartbeat** ([reddit-data-access §4](./sources/reddit-data-access.md)). |
| **Discord** | Deferred, pluggable `Source` | No ToS-friendly read API; revisit in Phase 5. |
| **Market data** | **Alpaca — settled** (behind the `MarketData` funnel; Massive / IBKR swappable) | Free IEX volume is thin → `rvol` low-confidence until SIP ($99) or IBKR. Per-ticker data gated to the WSB-hot list, but the free **screeners** (most-actives + movers) are a bounded market-wide read → **STEALTH is feasible (bounded)**, detection in Phase 3. |
| **Post classification (LLM)** | **Deferred to Phase 4** (2026-06-03 review) | v0.0.1 ships the SoV mention radar + market overlay; structured per-post extraction (direction/P&L/win-loss) comes later, **per-post only**. |
| **Cadence** | Near-live, **5 min** (poll + recompute) | Right granularity for "what's WSB trading now"; not tick-level. |

## How it works (one screen)

```
 Reddit taps ──► extract tickers ──► classify (flair/direction) ──► window-aggregate
 (Arctic-Shift,                                                       │
  PullPush)                                                           ▼
                                                        WSB Heat  H_e  (mentions·z·accel·dir)
                                                                       │ top-N hot leaderboard
 Market funnel ──► snapshots + option chains (gated to hot tickers) ──┤
 (Alpaca/Massive)                                       Market Heat H_m (rvol·pcr·iv·breadth)
                                                                       ▼
                                          H_e × H_m → divergence · quadrant · lead-lag → RADAR
```

Architecture, schema, cadence, tech stack: [`design/architecture.md`](./design/architecture.md).

## Running the scaffold (v0.0.1)

Tooling is **[uv](https://docs.astral.sh/uv/)** — no manual venv, no `pip install`. Install it once
(`curl -LsSf https://astral.sh/uv/install.sh | sh` — note `pip install uv` is blocked by PEP 668 on
the brew Python; ensure `~/.local/bin` is on `PATH`), then from `_random/wsb-signals/`:

```bash
uv sync                       # build the managed env from pyproject.toml + uv.lock
cp .env.example .env          # then fill ALPACA_API_KEY / ALPACA_API_SECRET (gitignored)
uv run wsb init-db            # create the DuckDB schema at data/wsb.duckdb
uv run wsb build-whitelist    # fetch the Alpaca ticker universe → whitelist/symbols.txt (refresh weekly)
uv run wsb run                # the radar: 5-min loop (poll → H_e → market overlay → snapshot + heartbeat)
uv run wsb aggregate          # one-shot: current window from stored mentions → H_e board (no market)
uv run wsb market             # one-shot: aggregate + Alpaca overlay (ret/rvol/H_m) + screeners
uv run wsb dashboard          # Streamlit board: Live leaderboard + history tabs (drill-down/trends/daily)
uv run wsb poll-once          # single poll → raw smoke count (no aggregation)
uv run wsb eval-extractor     # extractor decision mix over a live window (precision proxy)
```

`poll-once`'s leaderboard ranks by **raw mention count** — a smoke check, *not* the product signal
(the SoV/`z` ranker is the Phase-1 aggregator). Tunables (cadence, regex, `H_e` weights) live in
`config.toml`; secrets only in `.env`.

**Run it for real → Docker Compose.** For unattended, always-on operation (the only way baselines
warm and the radar is genuinely "near-live"), run the **containerized** stack — one image, a `radar`
writer + a `dashboard` reader, and a persisted named volume:

```bash
cp .env.example .env            # fill ALPACA_API_KEY / ALPACA_API_SECRET
docker compose up -d --build    # radar (healthcheck = wsb heartbeat) + dashboard on :8501
docker compose logs -f radar    # live cycle logs   ·   docker compose ps   # health
```

Data (DB + snapshot) lives in the `wsb-data` volume and survives `down`/`up`. Full deployment notes
— Docker **and** the bare-metal systemd alternative — are in [`deploy/README.md`](./deploy/README.md).

**Operations (single-tap safety).** Arctic-Shift is the *only* live source (PullPush frozen, Reddit
API excluded), so `uv run wsb heartbeat` probes newest-item lag and **exits non-zero when the tap is
stale (1) or down (2)** — wire it into cron/monitoring. On alarm the runbook is simple: the radar
**stops** (there is no free fallback); re-test the tap (and PullPush, in case it un-freezes) before
resuming, and don't publish stale signals. Threshold: `heartbeat.max_staleness_seconds`.

## Honest caveats

1. **Correlational, not predictive.** Reported as *association + divergence*; never a "buy" signal.
2. **Reflexivity.** A measured "WSB leads" can be WSB *causing* the move (pump-then-revert), not
   forecasting it.
3. **Survivorship bias.** Winners post Gains; losers go quiet → raw gain-counts overstate success.
4. **Manipulation & bots.** WSB is explicitly speculative/manipulation-prone; bot/brigade/promo
   noise is real → de-noise (distinct authors, `astroturf`, bot filtering).
5. **Thin free-feed volume.** `rvol` is low-confidence on free IEX/EOD data; firm only on paid SIP.
6. **Liveness verified — but single-source.** Arctic-Shift is ~real-time (2026-06-03 probe) ✅, but
   **PullPush is frozen @2025-05-19**, so Arctic-Shift is the *only* recent-data source — a single
   point of failure guarded by an **active freshness heartbeat** (alarms on staleness), not passive
   header-watching.
7. **STEALTH is bounded, not impossible, on free data.** Per-ticker market data is gated to the
   WSB-hot list, but the free Alpaca **screeners** (most-actives + movers) are a market-wide read →
   "market moving, WSB hasn't noticed" is discoverable among the **loudest movers** (penny /
   leveraged-ETF noise needs filtering). Screener data is captured now (Phase 2); STEALTH detection
   is Phase 3 (`scripts/probe_alpaca.py` verified the screeners work free).

## Documentation map

**`sources/`** — what the data is and how to get it:
- [`wallstreetbets.md`](./sources/wallstreetbets.md) — the subreddit (culture, flairs, rules,
  ticker conventions, biases) + Discord servers (official `wsbverse` vs unofficial).
- [`reddit-data-access.md`](./sources/reddit-data-access.md) — **strategy:** which tap for what;
  the live-vs-archive freshness problem; cold-start recipe.
- [`arctic-shift-api.md`](./sources/arctic-shift-api.md) — exhaustive Arctic-Shift API reference.
- [`pullpush-api.md`](./sources/pullpush-api.md) — exhaustive PullPush API reference.
- [`market-data-access.md`](./sources/market-data-access.md) — **strategy:** the `MarketData`
  funnel; Alpaca vs Massive comparison + recommendation.
- [`massive.md`](./sources/massive.md) — Massive (Polygon) reference (endpoints, tiers, MCP).
- [`alpaca.md`](./sources/alpaca.md) — Alpaca reference (endpoints, IEX/SIP, options, MCP).
- [`ibkr.md`](./sources/ibkr.md) — IBKR Client Portal Web API + the **ibind** / **ibeam** tools.
- [`UPDATING.md`](./sources/UPDATING.md) — recipes for refreshing these source docs (which fetch
  method works per source).

**`design/`** — how the system works:
- [`signal-framework.md`](./design/signal-framework.md) — the two-family model, normalization,
  `H_e`/`H_m`, divergence quadrants, lead-lag. **Start here for the concept.**
- [`architecture.md`](./design/architecture.md) — pipeline, components, schema, cadence, stack.

[`ROADMAP.md`](./ROADMAP.md) — phased build plan (v0.0.1 = Phase 0→2; v0.0.2 = Phase 3).

## Glossary

- **Tap** — a Reddit archive API (Arctic-Shift, PullPush). **Funnel** — the pluggable market-data
  provider interface (Alpaca, Massive).
- **SoV** — share of voice = a ticker's mentions ÷ all mentions in a window.
- **`z`** — mentions vs the ticker's own hour-of-week baseline ("is this unusual?").
- **`H_e` / `H_m`** — WSB Heat (empirical) / Market Heat (analytical), each a normalized composite.
- **Divergence** — `H_e − H_m`; **Quadrants** — Confirmed / Hype / Stealth / Quiet.
- **RVOL** — relative volume = volume ÷ the ticker's average (market twin of SoV/z).
- **Options matrix breadth** — how spread out option volume is across the strike×expiry grid
  (concentrated = a WSB "lotto"; dispersed = broad positioning).
- **IEX vs SIP** — single-exchange (~2.5% volume, free) vs consolidated full-market feed (paid).
- **Flair** — WSB's enforced post label (DD/YOLO/Gain/Loss/News/Discussion); a high-integrity
  signal.

## Open decisions to revisit
- ~~Arctic-Shift content latency~~ — **resolved 2026-06-03: ~real-time ✅** (`scripts/probe_reddit_taps.py`); PullPush frozen → single-source risk to manage (active heartbeat, Phase 0.5).
- ~~LLM post-classification~~ — **deferred to Phase 4** (2026-06-03 review); SoV live radar ships first.
- **Normalization** — `sov`-primary, `z` gated on baseline readiness (decided 2026-06-03 review).
- **Market-data tier** — Alpaca settled; free IEX (thin volume) vs SIP ($99) still open for `rvol`. STEALTH is **feasible (bounded)** on the free screeners — no longer blocked on a paid feed (decided 2026-06-03, `scripts/probe_alpaca.py`).
- **Signal weights** for `H_e`/`H_m` — defaults now, tune in Phase 4.
- **Discord** — official `wsbverse` vs the larger unofficial server, and the ToS/access path.
