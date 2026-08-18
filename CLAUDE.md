# WSB Signals

Guidance for AI coding agents working with code in this repository.

The repo is becoming **WSB Plays**: capture r/wallstreetbets Gain/Loss/YOLO screenshot posts,
extract the positions from the broker screenshots (vision LLM), interpret how the gamble played out
against real market data, categorize it, track its outcome, and publish a browseable board. The
existing **trending radar** (share-of-voice → WSB Heat `H_e`, Alpaca overlay → Market Heat `H_m`,
divergence badges) keeps running as the Plays **data subsystem** — its mentions history is the
herd/trend evidence. Both are observational research, **not** a trading signal — keep that framing
in any user-facing copy.

## ⚠ Current state — READ THIS FIRST

- **WSB Plays — the product; IN BUILD.** Design approved 2026-08-18; work is sliced **P0–P6** and
  tracked as GitHub Issues under milestone **"WSB Plays v1"** (one issue per slice, with the
  checklist + gate). **Slice P0 (repo repositioning) has landed**: the frozen v0.0.1 Python oracle
  tree and the retired shadow gate are pruned from `main`.
- **The radar — v2 full-stack TypeScript; BUILT, cutover-approved (2026-06-09), running.** Node
  worker + Nuxt 4 SSR web + Postgres in a pnpm monorepo (`packages/{shared,worker,web}`); deploy is
  `deploy/v2/` (db + worker + web). The radar's behavior is **stable** — Plays adds beside it, and
  radar parity tables/semantics must not change (plays-plan §1).
- **v0.0.1 (Python) — PRUNED from `main`.** Recover at tag `v0.0.1` (the frozen radar) or
  **`oracle-final`** (radar + the `oracle/` fixture-dump harness — use this one to regenerate
  `fixtures/`; procedure in `fixtures/README.md`). The committed golden fixtures + worker parity
  tests remain the regression net pinning the scoring math.

**Building Plays? Read these two FIRST** — they are authoritative:
- [`design/plays-product.md`](./design/plays-product.md) — the product spec: capture contract,
  extraction schema, evidence/taxonomy, outcome tracking, web, **invariants P1–P9** (§8).
- [`design/plays-plan.md`](./design/plays-plan.md) — the build plan: architecture deltas (one
  process, three isolated loops), per-slice plans P0–P6 with gates, config, dependencies.

## Source of truth

The `design/` docs are authoritative; code references them by section number (e.g.
"signal-framework §4"). When you change behavior, **keep the doc and the code in sync** — drift
here is a real bug.

**Plays — the active direction (approved 2026-08-18):**
- `design/plays-product.md` — WSB Plays spec (what + why + invariants).
- `design/plays-plan.md` — its build plan (slices P0–P6; P0 landed).

**Concept & math (version-agnostic):**
- `design/signal-framework.md` — two signal families, normalization, `H_e`/`H_m`, divergence
  quadrants, lead-lag. **Read this first to understand the radar's *why*.**
- `design/architecture.md` — the radar's pipeline/schema/cadence as designed for v0.0.1; the
  **§5 non-negotiables** below still hold in v2.

**v2 radar (as-built record):**
- `design/v2-plan.md` — topology, monorepo layout, stack, build order (all slices complete).
- `design/v2-porting-spec.md` — the Python→TS parity contract. The §12 live-shadow gate **ran,
  passed, and is tombstoned** — the shadow machinery is gone; the fixtures + parity tests and the
  unconditional post-publish read-back (`verifyPublished` in `db.ts`) are what survive.

**History:** `ROADMAP.md` — phased build history; the old radar Phase-3 remnants (STEALTH, alerts)
are **parked indefinitely**. `sources/` — per-provider API references + data-access strategy.

## Commands (pnpm monorepo on `main`)

**Node 24 LTS + pnpm** (pinned via `.nvmrc` + `packageManager`). Packages live in
`packages/{shared,worker,web}`; the worker's parity tests gate against the golden fixtures in
`fixtures/`. Deploy is `deploy/v2/compose.yml` (db + worker + web; see `deploy/v2/README.md`).

```bash
pnpm install                          # build the workspace (native builds pre-approved in pnpm-workspace.yaml)
pnpm -r --if-present run typecheck    # typecheck all (shared/worker → tsc, web → nuxt typecheck)
pnpm -r --if-present run test         # all unit tests (incl. parity vs fixtures/), Docker-free

# worker (@wsb/worker) — the radar loop (+ plays loops as they land)
pnpm -C packages/worker test          # unit + parity tests, Docker-free
pnpm -C packages/worker test:it       # testcontainers Postgres integration — NEEDS Docker
pnpm -C packages/worker typecheck
pnpm -C packages/worker dev           # run the worker entry (tsx; the 5-min poll loop)
pnpm -C packages/worker build-whitelist  # fetch Alpaca asset universe → whitelist/symbols.txt
pnpm -C packages/worker heartbeat     # Arctic-Shift freshness probe; exits 0 OK / 1 stale / 2 down

# web (@wsb/web) — Nuxt 4 SSR (read-only)
pnpm -C packages/web dev              # dev server
pnpm -C packages/web build            # full SSR build → .output/
pnpm -C packages/web typecheck        # nuxt typecheck (vue-tsc)
pnpm -C packages/web lint             # @nuxt/eslint (flat); shared/worker have no lint config

# shared (@wsb/shared) — Drizzle schema + inferred types
pnpm -C packages/shared db:generate   # regenerate the Postgres migration from src/schema.ts
```

Regenerating `fixtures/` (only if the scoring contract changes intentionally): see
`fixtures/README.md` — worktree at tag `oracle-final`, run the old dump script, copy back.

## Pipeline (data flow)

Radar: `Arctic-Shift poll → extract tickers → classify direction → window-aggregate (H_e) → gate
market data to top-N hot → overlay (H_m) → divergence/quadrant signals → atomic publish → web board`.
Plays (being built, plan §1): `flair-matched raw posts → capture + media archive → LLM extract →
validate → evidence build → LLM interpret/categorize → publish → daily outcome marks`.

**v2 worker module map** (`packages/worker/src/`, plus `packages/{shared,web}`):

| Stage | Module | Notes |
|---|---|---|
| Ingest | `ingest.ts` | Arctic-Shift paginated descending poll; bounded retry-with-backoff on throttle/5xx (porting-spec §4.1). |
| Extract | `extract.ts` | Regex candidates → stoplist → whitelist → ambiguous-context gate (parity port). |
| Classify | `classify.ts` | Direction (bull/bear) from options/position words — **not** ironic sentiment. |
| Aggregate | `aggregate.ts` | mentions → `(ticker, window)` features + `H_e`; board order via `@wsb/shared` `compareBoard`. |
| Market | `market.ts` | Alpaca snapshots + screeners → `ret`/`rvol` → `H_m`; gated to top-N by `H_e`. |
| Signals | `analytics.ts` | divergence / quadrants / lead-lag (v2-only; porting-spec §11). |
| Orchestrate | `pipeline.ts` + `loop.ts` + `index.ts` | The 5-min cycle; SIGTERM, advisory lock, W−1-before-W. `index.ts` owns process-level handlers. |
| Store | `db.ts` (+ `@wsb/shared` schema/migrations) | Postgres via Drizzle; atomic per-cycle publish; ≤1000-row upsert chunks; unconditional post-publish read-back (`verifyPublished`). |
| Aux CLIs | `build-whitelist.ts` (`assets.ts`), `heartbeat.ts` | Ported from the v0.0.1 CLI. |
| Web | `packages/web` (`server/api/board`) | Read-only Nuxt 4 SSR; one REPEATABLE READ tx over the latest complete cycle. |
| Config | `config.ts` | `config.toml` (tunables) + env (`DATABASE_URL`, `ALPACA_*`). |

Plays modules land under `packages/worker/src/plays/` per `design/plays-plan.md` (capture, media,
analyzer seam, evidence, queue, marks).

## Pluggable interfaces (the extension seams)

- **`Source`** (`ingest.ts`) — one abstraction over Reddit taps. `ArcticShiftSource` is the only
  live impl (PullPush frozen; Reddit API excluded). **Stays plays-agnostic** — flair filtering for
  capture happens in plays code, never inside `poll()` (plays-plan §3).
- **`MarketData`** (`market.ts`) — the funnel over market providers. `AlpacaMarketData` (free) is
  the only impl; Massive / IBKR are intended alternatives behind the same interface. Current
  surface is stock snapshots + screeners; **P5 grows it** (trading calendar + option snapshots).
- **`PlayAnalyzer`** (P2, `plays/analyzer.ts`) — the LLM seam (`extract(images, text)`,
  `interpret(evidence)`); Vercel AI SDK behind it, provider-agnostic. Pipeline code never imports
  `ai` directly.

## Radar invariants you must not break (architecture §5; enforced in code)

Plays has its own invariants **P1–P9** — see `design/plays-product.md` §8. The radar's:

- **Rank on `sov`, never raw counts or cold-start `z`.** `z` is computed but kept out of the `H_e`
  blend until its hour-of-week baseline is `ready` (config weight `heat.weights.z = 0.00` until
  then). Baselines are **forward-only** — no backfill.
- **Components are max-normalized within the window, not percentile-ranked** — see the
  `maxNorm` docstring in `aggregate.ts` for *why* (percentile rank would let secondaries override
  the SoV-primary signal).
- **Ranking is deterministic** — equal-scored rows break ties by an explicit total order
  (`h_e → sov → authors → mentions → ticker`, `compareBoard` in `@wsb/shared`), and the DB reads
  are `ORDER BY`-stable; the board never depends on DB row or dict-insertion order.
- **`velocity`/`accel` are `null` when there is no real prior window** (cold start or a polling
  gap). Emitting 0-based deltas would make every ticker look like a fresh breakout and inflate
  `H_e`. The loop re-aggregates W−1 (persist-only) before the current window so prior-window
  momentum is final.
- **A partial poll (`PollResult.ok == false`) is discarded whole** — not persisted, aggregated, or
  marked — because an undercounted window biases the SoV denominator.
- **A `capped` poll (pagination cap hit) is persisted but flagged low-trust** — surfaced via
  `cycle_runs.capped` → the web banner as undercounted/untrustworthy `sov`. Don't treat capped as
  complete.
- **Missing whitelist fails CLOSED to cashtag-only**, never to bare-token extraction (which would
  flood the board with uppercase non-tickers). See `buildExtractor` in `config.ts`.
- **`rvol` / `ret` are day-to-date, NOT window-aligned** — `H_m` answers "hot *today*", not "hot
  *this hour*". `rvol` is tagged low-confidence (`rvol_conf="low"`) on the thin free IEX feed.
- **Outcome/P&L stays per-post — never aggregate to a per-ticker win rate** (survivorship bias).
  Binding for Plays too (invariant P5).
- **Arctic-Shift is the sole live tap** (no free fallback). `heartbeat` alarms on staleness; the
  runbook is: radar stops, re-test before resuming. Don't publish stale signals.

## Concurrency & process model

- **The worker is the single Postgres writer** (advisory-lock double-run guard, atomic per-cycle
  publish); the web reads via a **read-only PG role the worker provisions on boot**
  (`packages/worker/src/ensure-read-role.ts`).
- The worker loop is a recursive-timeout loop — **never `setInterval`** (ticks must not overlap).
  Per-cycle self-heal (`try/catch`), SIGTERM → graceful shutdown, startup throttle.
- Plays adds two more loops in the same process under strict isolation rules (dedicated PG pool,
  no tx across LLM/network calls, `index.ts` owns process handlers) — plays-plan §1.

## Config & secrets

- `config.toml` — committed tunables (cadence, regex, `H_e`/`H_m` weights, thresholds; `[plays]`
  blocks land with their slices). Parsed by `packages/worker/src/config.ts`.
- Secrets are env-only, **gitignored**: the worker needs `DATABASE_URL` (writer role) + `ALPACA_*`
  (+ `OPENAI_API_KEY` from Plays P2); the web needs only `DATABASE_URL` (read-only role). Deploy
  secrets live in `deploy/v2/.env` (from `.env.example`).
- `whitelist/symbols.txt` is **derived** (gitignored; `pnpm -C packages/worker build-whitelist`);
  `whitelist/stoplist.txt` and `ambiguous.txt` are curated and committed.
