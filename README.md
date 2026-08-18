# WSB Signals

Two things live here, one product direction:

- **WSB Plays** (the product; **in build**) — capture r/wallstreetbets **Gain / Loss / YOLO**
  screenshot posts, extract the actual positions from the broker screenshots (vision LLM),
  interpret how the gamble played out against real market data, categorize the play
  (dumb-luck / high-risk-high-reward / herd-following / …), track its outcome over time, and
  publish a browseable board of plays.
- **The trending radar** (running today; becomes the Plays **data subsystem**) — a near-live
  leaderboard of which tickers WSB is piling into *right now* (share-of-voice → **WSB Heat
  `H_e`**), overlaid with Alpaca market data (**Market Heat `H_m`**) and badged by
  attention×action divergence. Its mentions history is the herd/trend evidence Plays consumes.

> **Status.** The **radar is v2** — full-stack TypeScript, built and cutover-approved
> (2026-06-09): a standalone Node **worker** (`packages/worker`) polls Arctic-Shift every 5 min,
> computes the SoV-primary `H_e` board, overlays Alpaca (`ret`/`rvol` → `H_m`), and publishes
> atomically to **Postgres**; a read-only **Nuxt 4 SSR board** (`packages/web`) serves it.
> **Plays** is design-approved (2026-08-18) and being built in slices **P0–P6**, tracked as
> GitHub Issues under milestone **"WSB Plays v1"** — spec in
> [`design/plays-product.md`](./design/plays-product.md), build plan in
> [`design/plays-plan.md`](./design/plays-plan.md).
>
> The original **v0.0.1 Python radar** (the v2 parity oracle) has been **pruned from `main`**
> (slice P0) — recover it at tag `v0.0.1` (the frozen radar) or `oracle-final` (radar + the
> fixture-dump harness). The committed golden fixtures in [`fixtures/`](./fixtures/README.md)
> remain the regression net pinning the scoring math.
>
> **This is observational/correlational research, not financial advice.** WSB *moves* the names
> it discusses (reflexivity), gain-posts are survivorship-biased, and the sub is a
> manipulation-prone environment. The system *measures* the attention↔market relationship — and
> documents individual gambles — it does not predict returns. See [Honest caveats](#honest-caveats).

## WSB Plays (the product being built)

```
 radar poll (flair-matched raw posts) ──► capture + media archive ──► LLM extract (vision)
      ──► validate ──► evidence build (radar herd/trend + market) ──► LLM interpret/categorize
      ──► publish to the plays board ──► daily outcome marks (Alpaca) until resolution
```

One worker process, three isolated loops (radar / plays queue / marks job), same Postgres.
Everything is specified in [`design/plays-product.md`](./design/plays-product.md) (capture
contract, extraction schema, taxonomy, outcome tracking, invariants P1–P9) and
[`design/plays-plan.md`](./design/plays-plan.md) (architecture deltas, per-slice plans and gates).

## The radar (running today)

Per **(ticker, time-window)** cell, two comparable signal families and their interaction:

- **Empirical** (what the *community* does): mention volume & share-of-voice, momentum
  (velocity/accel/z), bet direction (calls vs puts), flair mix, conviction → **WSB Heat `H_e`**.
- **Analytical** (what the *market* does): price return, relative volume → **Market Heat `H_m`**.

The board badges each hot ticker by quadrant — **Confirmed** (chatter + market agree), **Hype**
(loud, no follow-through), **Stealth** (market moving, WSB hasn't noticed), **Quiet** — plus a
rolling **lead-lag** estimate. Full model: [`design/signal-framework.md`](./design/signal-framework.md).

## Running it

**Node 24 LTS + [pnpm](https://pnpm.io/)** (pinned via `.nvmrc` + `packageManager`), in a pnpm
monorepo: `packages/shared` (Drizzle schema + types), `packages/worker` (the radar + plays loops),
`packages/web` (the board).

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

Tunables (cadence, regex, `H_e`/`H_m` weights, plays knobs) live in `config.toml`; secrets only in
env / the gitignored `.env` files.

**Operations (single-tap safety).** Arctic-Shift is the *only* live source (PullPush frozen, Reddit
API excluded), so the `heartbeat` CLI probes newest-item lag and **exits non-zero when the tap is
stale (1) or down (2)** — it doubles as the worker container's healthcheck. On alarm the runbook is
simple: the radar **stops** (there is no free fallback); re-test the tap before resuming, and don't
publish stale signals. Threshold: `heartbeat.max_staleness_seconds`. Transient Arctic-Shift
throttling (`422 "slow down"`/5xx) is absorbed by bounded retry-with-backoff in the ingest.

## History (v0.0.1 → v2 → Plays)

The radar was first built in Python + DuckDB + Streamlit (**v0.0.1**, Phase 0→2), then re-implemented
in TypeScript (**v2**) with the frozen Python tree as the **parity oracle**: golden fixtures were
dumped from it (`fixtures/`, still committed) and a live replay-vs-oracle shadow gate diffed the two
until cutover **passed (2026-06-09)**. With the gate's job done, the Python tree and the shadow
machinery were pruned from `main` (Plays slice P0, 2026-08-18):

- tag **`v0.0.1`** — the frozen Python radar;
- tag **`oracle-final`** — the last commit carrying the oracle tree *plus* the `oracle/`
  fixture-dump/replay harness (use this to regenerate `fixtures/` — see
  [`fixtures/README.md`](./fixtures/README.md));
- [`ROADMAP.md`](./ROADMAP.md) — the full phased history.

## Honest caveats

1. **Correlational, not predictive.** Reported as *association + divergence*; never a "buy" signal.
2. **Reflexivity.** A measured "WSB leads" can be WSB *causing* the move (pump-then-revert), not
   forecasting it.
3. **Survivorship bias.** Winners post Gains; losers go quiet → raw gain-counts overstate success.
   For Plays this is a hard rule: outcome/P&L stays **per-post**, never aggregated into a
   per-ticker "win rate".
4. **Manipulation & bots.** WSB is explicitly speculative/manipulation-prone; bot/brigade/promo
   noise is real → de-noise (distinct authors, bot filtering).
5. **Thin free-feed volume.** `rvol` is low-confidence on free IEX data; firm only on paid SIP.
6. **Liveness verified — but single-source.** Arctic-Shift is ~real-time (2026-06-03 probe) ✅, but
   PullPush is frozen @2025-05-19, so Arctic-Shift is the *only* recent-data source — a single
   point of failure guarded by an **active freshness heartbeat**, not passive header-watching.
7. **STEALTH is bounded on free data.** Free Alpaca screeners (most-actives + movers) are the one
   market-wide read; full STEALTH detection is parked with the old radar roadmap (see ROADMAP).

## Documentation map

**`design/`** — how the system works:
- [`plays-product.md`](./design/plays-product.md) — **the WSB Plays product spec** (capture,
  extraction, taxonomy, outcomes, invariants). **The active direction.**
- [`plays-plan.md`](./design/plays-plan.md) — the Plays build plan (slices P0–P6, config, deps).
- [`signal-framework.md`](./design/signal-framework.md) — the two-family model, normalization,
  `H_e`/`H_m`, divergence quadrants, lead-lag (version-agnostic concept behind the radar).
- [`v2-plan.md`](./design/v2-plan.md) — the v2 radar blueprint + as-built record.
- [`v2-porting-spec.md`](./design/v2-porting-spec.md) — the Python→TS parity contract (gate
  executed + passed; §12 tombstoned).
- [`architecture.md`](./design/architecture.md) — pipeline/schema/cadence as designed for v0.0.1;
  the §5 invariants still hold in v2.

**`sources/`** — what the data is and how to get it:
- [`wallstreetbets.md`](./sources/wallstreetbets.md) — the subreddit (culture, flairs, rules,
  ticker conventions, biases).
- [`reddit-data-access.md`](./sources/reddit-data-access.md) — **strategy:** which tap for what;
  the live-vs-archive freshness problem.
- [`arctic-shift-api.md`](./sources/arctic-shift-api.md) — exhaustive Arctic-Shift API reference.
- [`pullpush-api.md`](./sources/pullpush-api.md) — exhaustive PullPush API reference (frozen tap).
- [`market-data-access.md`](./sources/market-data-access.md) — **strategy:** the `MarketData`
  funnel; Alpaca vs Massive.
- [`alpaca.md`](./sources/alpaca.md) — Alpaca reference (endpoints, IEX/SIP, options, MCP).
- [`massive.md`](./sources/massive.md) / [`ibkr.md`](./sources/ibkr.md) — alternative providers.
- [`UPDATING.md`](./sources/UPDATING.md) — recipes for refreshing these source docs.

[`ROADMAP.md`](./ROADMAP.md) — phased build history and the current direction.

## Glossary

- **Play** — one captured Gain/Loss/YOLO post: the screenshots, the extracted positions, the
  interpretation, and its tracked outcome.
- **Tap** — a Reddit archive API (Arctic-Shift, PullPush). **Funnel** — the pluggable market-data
  provider interface (Alpaca, Massive).
- **SoV** — share of voice = a ticker's mentions ÷ all mentions in a window.
- **`z`** — mentions vs the ticker's own hour-of-week baseline ("is this unusual?").
- **`H_e` / `H_m`** — WSB Heat (empirical) / Market Heat (analytical), each a normalized composite.
- **Divergence** — `H_e − H_m`; **Quadrants** — Confirmed / Hype / Stealth / Quiet.
- **RVOL** — relative volume = volume ÷ the ticker's average (market twin of SoV/z).
- **IEX vs SIP** — single-exchange (~2.5% volume, free) vs consolidated full-market feed (paid).
- **Flair** — WSB's enforced post label (DD/YOLO/Gain/Loss/News/Discussion); a high-integrity
  signal — and the Plays capture trigger.
