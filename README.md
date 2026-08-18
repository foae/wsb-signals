# WSB Signals

A near-live **"trending radar"** for r/wallstreetbets: surface which stock tickers the WSB
community is piling into *right now*, and overlay real market data (price, volume, options) to
show whether the market is **confirming** the chatter or **diverging** from it.

> **Status: v2 — the full-stack TypeScript radar is BUILT and cutover-approved (2026-06-09).**
> A standalone Node **worker** (`packages/worker`) polls Arctic-Shift every 5 min, computes the
> SoV-primary, baseline-gated **`H_e`** leaderboard, overlays Alpaca market data (`ret`/`rvol` →
> **`H_m`**), computes the **divergence / quadrant** signals, and publishes atomically to
> **Postgres**; a read-only **Nuxt 4 SSR board** (`packages/web`) serves it. All port slices (0–10)
> are complete and the live replay-vs-oracle parity gate **passed** (see
> [`design/v2-plan.md`](./design/v2-plan.md) + [`design/v2-porting-spec.md`](./design/v2-porting-spec.md)).
> Deploy is [`deploy/v2/`](./deploy/v2/README.md) (db + worker + web).
>
> **v0.0.1 (Python + DuckDB + Streamlit, tagged `v0.0.1`) is FROZEN** — kept in-tree at the root as
> the **parity oracle** the TS port is diffed against, not as a thing to run or extend. v0.0.1 =
> Phase 0→2 (radar + overlay); the v0.0.2 product (divergence/quadrants/STEALTH/lead-lag) is built
> **within v2**. See [`ROADMAP.md`](./ROADMAP.md).
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

v2 topology, stack, build order: [`design/v2-plan.md`](./design/v2-plan.md). The concept-level
pipeline, schema and cadence (written for v0.0.1; §5 invariants carry to v2):
[`design/architecture.md`](./design/architecture.md).

## Running it (v2 — the radar)

**Node 24 LTS + [pnpm](https://pnpm.io/)** (pinned via `.nvmrc` + `packageManager`), in a pnpm
monorepo: `packages/shared` (Drizzle schema + types), `packages/worker` (the radar), `packages/web`
(the board).

**Run it for real → Docker Compose (3 services: db + worker + web):**

```bash
cp deploy/v2/.env.example deploy/v2/.env               # set POSTGRES_PASSWORD + ALPACA_API_KEY/SECRET
docker compose -f deploy/v2/compose.yml up -d --build  # Postgres + worker (migrates on boot) + web on :3000
docker compose -f deploy/v2/compose.yml logs -f worker # live cycle logs
```

The worker is the single Postgres writer (atomic per-cycle publish, advisory lock, heartbeat
healthcheck) and provisions the **read-only** role the web uses. Full notes:
[`deploy/v2/README.md`](./deploy/v2/README.md).

**Develop locally:**

```bash
pnpm install                          # workspace install (Node 24; native builds pre-approved)
pnpm -r --if-present run typecheck    # tsc (shared/worker) + nuxt typecheck (web)
pnpm -r --if-present run test         # unit + parity tests (vs fixtures/), Docker-free
pnpm -C packages/worker test:it       # testcontainers Postgres integration tests — needs Docker
pnpm -C packages/worker dev           # the 5-min poll loop (needs DATABASE_URL + ALPACA_*)
pnpm -C packages/worker build-whitelist  # Alpaca ticker universe → whitelist/symbols.txt (refresh weekly)
pnpm -C packages/worker heartbeat     # Arctic-Shift freshness probe; exits 0 OK / 1 stale / 2 down
pnpm -C packages/web dev              # the Nuxt board against the same Postgres (read-only)
```

Tunables (cadence, regex, `H_e`/`H_m` weights) live in `config.toml`; secrets only in env / the
gitignored `.env` files.

**Operations (single-tap safety).** Arctic-Shift is the *only* live source (PullPush frozen, Reddit
API excluded), so the `heartbeat` CLI probes newest-item lag and **exits non-zero when the tap is
stale (1) or down (2)** — it doubles as the worker container's healthcheck. On alarm the runbook is
simple: the radar **stops** (there is no free fallback); re-test the tap (and PullPush, in case it
un-freezes) before resuming, and don't publish stale signals. Threshold:
`heartbeat.max_staleness_seconds`. Transient Arctic-Shift throttling (`422 "slow down"`/5xx) is
absorbed by bounded retry-with-backoff in the ingest.

## The frozen v0.0.1 oracle (Python)

The original Python + DuckDB + Streamlit radar stays in-tree (`wsb_signals/`, tagged `v0.0.1`) as
the **parity oracle**: golden fixtures in `fixtures/` are dumped from it, and the live shadow gate
replays the TS worker's inputs through it (`oracle/README.md`). It is feature-frozen and not
deployed. Tooling is **[uv](https://docs.astral.sh/uv/)**
(`curl -LsSf https://astral.sh/uv/install.sh | sh`):

```bash
uv sync                              # build the managed env from pyproject.toml + uv.lock
uv run --extra dev pytest            # the oracle's own test suite
uv run python oracle/dump_fixtures.py   # regenerate the committed golden parity fixtures
uv run wsb run --once --no-market    # single empirical-only cycle (needs init-db first; see CLAUDE.md)
```

The full `wsb` CLI (`init-db`, `run`, `aggregate`, `market`, `dashboard`, `poll-once`,
`eval-extractor`, `heartbeat`) still works and is documented in [`CLAUDE.md`](./CLAUDE.md); the root
`docker-compose.yml` + [`deploy/README.md`](./deploy/README.md) describe its (now-retired)
radar + dashboard deployment.

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
- [`v2-plan.md`](./design/v2-plan.md) — **the v2 blueprint + as-built record** (full-stack TypeScript;
  all slices complete, cutover-approved).
- [`v2-porting-spec.md`](./design/v2-porting-spec.md) — the Python→TS **parity contract** for v2
  (gate executed + passed, §12).
- [`signal-framework.md`](./design/signal-framework.md) — the two-family model, normalization,
  `H_e`/`H_m`, divergence quadrants, lead-lag (version-agnostic concept). **Start here for the concept.**
- [`architecture.md`](./design/architecture.md) — pipeline, components, schema, cadence, stack (v0.0.1).

[`ROADMAP.md`](./ROADMAP.md) — phased build history (v0.0.1 = Phase 0→2, **frozen**; v2 = full-stack TS).

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
