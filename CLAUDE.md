# WSB Signals

Guidance for AI coding agents working with code in this repository.

The repo is becoming **WSB Plays**: capture r/wallstreetbets Gain/Loss/YOLO screenshot posts,
extract the positions from the broker screenshots (vision LLM), interpret how the gamble played out
against real market data, categorize it, track its outcome, and publish a browseable board. The
existing **trending radar** (share-of-voice → WSB Heat `H_e`, Alpaca overlay → Market Heat `H_m`,
divergence badges) keeps running as the Plays **data subsystem** — its mentions history is the
herd/trend evidence. Both are observational research, **not** a trading signal — that framing holds
in docs and analysis output, but the owner removed the disclaimer taglines from the web UI
(2026-08-20): do NOT re-add "observational research / not a trading signal" copy to pages.

## ⚠ Current state — READ THIS FIRST

- **WSB Plays — the product; IN BUILD.** Design approved 2026-08-18; work is sliced **P0–P6** and
  tracked as GitHub Issues under milestone **"WSB Plays v1"** (one issue per slice, with the
  checklist + gate). **Slice P0 (repo repositioning) has landed**: the frozen v0.0.1 Python oracle
  tree and the retired shadow gate are pruned from `main`. **Slice P1 (capture & media) LANDED,
  gate passed 2026-08-18** (issue #2) — flair-matched capture, media archive, plays queue skeleton,
  bare `/plays` web list, all verified live. Gate findings: galleries resolve **locally from the
  archived raw** (Reddit's post-JSON endpoint 403s non-browser clients — fallback only); the stack
  runs in the dedicated `wsb-signals` incus CT. **P2 (LLM seam & extraction, issue #3): machine
  gate MET 2026-08-20** (labeled eval n=36, marking-critical fields 100%; live extraction on
  `gpt-5.6-sol` via ChatGPT-subscription OAuth — `codex-login`); the owner spot-check of the
  labeled sample is the one open human step. **P3 (interpretation/categorization/publish,
  issue #4) is BUILT — live gate (~20 hand-reviewed published plays) pending.** **P4 (web board,
  issue #5) is BUILT 2026-08-20** — plays are the primary UI at `/` (heat board at `/board`),
  server-side filters/sorts, default hide of low-confidence/`unclassifiable`; the owner
  browse-the-LAN-deploy gate is pending.
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

Plays modules live under `packages/worker/src/plays/` per `design/plays-plan.md`. Landed at P1:
`capture.ts` (flair filter + ON CONFLICT DO NOTHING enqueue, called from `runCycle` AFTER
`publishCycle` commits; since 2026-08-20 also the junk gates — 15-min capture delay, removed-post
skip, thin text-only skip — and a zero-position extraction tombstones as terminal `discarded`,
hidden from the web, plays-plan §3), `media.ts` (resolver/archiver: direct + gallery-from-archived-raw (Reddit-JSON fallback, 403-prone) + inline
self-post images; transient-vs-permanent split), `queue.ts` (the second loop: `FOR UPDATE SKIP
LOCKED` lease claim on a DEDICATED pool, stale-claim recovery, backoff). Landed at P2:
`extraction.ts` (the PINNED zod schema + derived direction), `marking.ts` (the pure P2↔P5 markPlay
pin), `validate.ts` (three-outcome ticker check, arithmetic cross-check, derived confidence,
deterministic position_ids), `analyzer.ts` (the seam; sole `ai` importer) + `prompts/`,
`images.ts` (sharp prep), `metering.ts` (fail-closed pricing + DB-summed daily budget),
`eval.ts` (`plays-eval` over `fixtures/plays/`). Landed at P3: `evidence.ts` (deterministic
radar/herd/market evidence; anchor at `opened_at` else post-time-badged-weaker; last-complete-window
+ staleness bound; distinct-author herd measure), `interpretation.ts` (per-call category enum — the
STRUCTURAL herd gate, invariant P4) + `prompts/interpret.ts`; the queue runs `captured →
media_ready → extracted → published` (interpret+denormalize+publish is ONE stage/row-update —
there is deliberately no `analyzed` status). Still to land: marks (P5). Landed at P4: the web
serves the shared media volume via `/api/media/**` (prefix-checked; `NUXT_MEDIA_DIR`); plays are
the primary UI at `/` (heat board at `/board`; board tickers cross-link `/?ticker=X`) with
**server-side** filters/sorts and the default low-confidence/`unclassifiable` hide
(`PlaysQuerySchema`/`LOW_CONFIDENCE` in `server/utils/plays.ts` — children read by current-run
pointers, lenient jsonb schemas), plus a `/plays/:id` detail page with the P5 outcome placeholder.

## Pluggable interfaces (the extension seams)

- **`Source`** (`ingest.ts`) — one abstraction over Reddit taps. `ArcticShiftSource` is the only
  live impl (PullPush frozen; Reddit API excluded). **Stays plays-agnostic** — flair filtering for
  capture happens in plays code, never inside `poll()` (plays-plan §3).
- **`MarketData`** (`market.ts`) — the funnel over market providers. `AlpacaMarketData` (free) is
  the only impl; Massive / IBKR are intended alternatives behind the same interface. Current
  surface is stock snapshots + screeners + optional `dailyBars` (plays evidence, P3); **P5 grows
  it** (trading calendar + option snapshots).
- **`PlayAnalyzer`** (`plays/analyzer.ts`) — the LLM seam: `extract(images, text)` (P2) and
  `interpret(req)` (P3; text-only, `allowHerd` decided by the caller). Two impls behind `buildAnalyzer`:
  `AiSdkAnalyzer` (platform key, Vercel AI SDK) and `CodexAnalyzer` (ChatGPT-subscription OAuth —
  the LIVE provider since 2026-08-19; metering is notional there; auth established via
  `pnpm -C packages/worker codex-login`, self-refreshed by `codex-auth.ts`). Pipeline
  code never imports `ai` or provider clients directly; tests inject a fake.

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
  (+ `OPENAI_API_KEY` from Plays P2); the web needs only `DATABASE_URL` (read-only role) plus the
  non-secret `NUXT_MEDIA_DIR` (the plays media volume, set in compose). Deploy
  secrets live in `deploy/v2/.env` (from `.env.example`).
- `whitelist/symbols.txt` is **derived** (gitignored; `pnpm -C packages/worker build-whitelist`);
  `whitelist/stoplist.txt` and `ambiguous.txt` are curated and committed.
