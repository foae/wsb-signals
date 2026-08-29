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

> **🧊 CONSERVED 2026-08-29 — nothing is deployed and nothing is running.** The Incus CT, its Docker
> images and **all three data volumes** were deleted; the database and media archive are gone. The
> code, `design/` docs, `fixtures/` and the open P2–P7 milestone issues survive unchanged.
> **[`CONSERVATION.md`](./CONSERVATION.md) is authoritative for anything deployment-, secret-,
> model- or restart-related** — read it before acting on any operational instruction below, since
> the sections that follow describe the stack **as it ran**, in the present tense.

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
  browse-the-LAN-deploy gate is pending. **P6 agent analysis tooling is BUILT and live 2026-08-21**
  — progressive discovery docs, bounded read-only API/CLI, direct snapshot exports, and canonical
  SQL; P6's separate reprocess path/polish work remains.
- **The radar — v2 full-stack TypeScript; BUILT, cutover-approved (2026-06-09), running.** Node
  worker + Nuxt 4 SSR web + Postgres in a pnpm monorepo (`packages/{shared,worker,web}`); deploy is
  `deploy/v2/`. **Heat correctness hardening landed 2026-08-21:** explicit finalization, per-kind
  source coverage, stable per-ticker `H_m`, market provenance/coverage, support-gated quadrants,
  removal repair, versioned scores, ticker history, and calibration/extraction quality gates.
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
- `design/plays-plan.md` — its build plan and current slice contracts.
- `design/plays-analysis.md` — agent-facing read-only API/CLI/export contract and canonical SQL.

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
pnpm -C packages/worker analyze -- catalog  # discover the deployed read-only analysis API
pnpm -C packages/worker plays-export -- --from 2026-08-01 --to 2026-08-21 --range-basis anchor --format json
pnpm -C packages/worker heat-extract-eval  # labeled ticker precision/recall gate
pnpm -C packages/worker heat-calibrate -- --from 2026-08-01 --to 2026-08-21

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
| Ingest | `ingest.ts` | Arctic-Shift paginated poll; per-kind bounds/status persisted; bounded retry on throttle/5xx. |
| Extract | `extract.ts` | Regex → stoplist → whitelist → ambiguous-context gate; BTC/ETH collisions gated; labeled eval. |
| Classify | `classify.ts` | Direction (bull/bear) from options/position words — **not** ironic sentiment. |
| Aggregate | `aggregate.ts` | mentions → `(ticker, window)` + `H_e`; removed content excluded; canonical `compareBoard`. |
| Market | `market.ts` | snapshots + cached daily profiles → stable per-ticker `ret`/session-rvol/`H_m`; true as-of; top-N gated. |
| Signals | `analytics.ts` | divergence / support-gated quadrants; lead-lag remains disabled while H_m is day-to-date. |
| Orchestrate | `pipeline.ts` + `loop.ts` + `index.ts` | Exact empirical/signal replacement; W−1 refresh; continuous stable-window catch-up; observed-at removal repair. |
| Store | `db.ts` (+ shared schema/migrations) | Atomic publish, version/finalize/repair provenance, coverage, unconditional post-publish read-back. |
| Aux CLIs | `build-whitelist.ts`, `heartbeat.ts`, `heat-{extract-eval,calibrate}.ts`, `analysis/` | Quality, ops, and agent analysis. |
| Web | `packages/web` | SSR live board + mobile cards + `/board/:ticker` finalized history; REPEATABLE READ APIs. |
| Agent analysis | `packages/web/server/api/analysis` + `server/utils/analysis.ts` | Bounded finalized dossiers/audits; see `design/plays-analysis.md`. |
| Config | `config.ts` | `config.toml` tunables + env secrets. |

Plays modules live under `packages/worker/src/plays/` per `design/plays-plan.md`. Landed at P1:
`capture.ts` (flair filter + ON CONFLICT DO NOTHING enqueue, called from `runCycle` AFTER
`publishCycle` commits; since 2026-08-20 also the 15-min capture delay and removed-post skip; since
2026-08-25 short text-only posts proceed to extraction because title + short body can describe a
real position, while a zero-position extraction tombstones as terminal `discarded` and stays hidden
from the web, plays-plan §3), `media.ts` (resolver/archiver: direct + gallery-from-archived-raw
(Reddit-JSON fallback, 403-prone) + inline
self-post images; transient-vs-permanent split), `queue.ts` (the second loop: `FOR UPDATE SKIP
LOCKED` lease claim on a DEDICATED pool, stale-claim recovery, backoff). Landed at P2:
`extraction.ts` (the PINNED zod schema + derived direction), `marking.ts` (the pure P2↔P5 markPlay
pin), `validate.ts` (three-outcome ticker check, arithmetic cross-check, derived confidence,
deterministic position_ids), `analyzer.ts` (the seam; sole `ai` importer) + `prompts/`,
`images.ts` (sharp prep), `metering.ts` (fail-closed pricing + DB-summed daily budget),
`eval.ts` (`plays-eval` over `fixtures/plays/`). Landed at P3: `evidence.ts` (deterministic
radar/herd/market evidence; anchor at `opened_at` else post-time-badged-weaker; explicit
last-finalized-window + staleness bound; distinct-author herd measure), `interpretation.ts`
(per-call category enum — the STRUCTURAL herd gate, invariant P4) + `prompts/interpret.ts`; the queue runs `captured →
media_ready → extracted → published` (interpret+denormalize+publish is ONE stage/row-update —
there is deliberately no `analyzed` status). Still to land: marks (P5). Landed at P4: the web
serves the shared media volume via `/api/media/**` (prefix-checked; `NUXT_MEDIA_DIR`); plays are
the primary UI at `/` (heat board at `/board`; ticker history at `/board/:ticker`) with
**server-side** filters/sorts and the default low-confidence/`unclassifiable` hide
(`PlaysQuerySchema`/`LOW_CONFIDENCE` in `server/utils/plays.ts` — children read by current-run
pointers, lenient jsonb schemas), plus a `/plays/:id` detail page with the P5 outcome placeholder.

## Pluggable interfaces (the extension seams)

- **`Source`** (`ingest.ts`) — one abstraction over Reddit taps. `ArcticShiftSource` is the only
  live impl (PullPush frozen; Reddit API excluded). **Stays plays-agnostic** — flair filtering for
  capture happens in plays code, never inside `poll()` (plays-plan §3).
- **`MarketData`** (`market.ts`) — the funnel over market providers. `AlpacaMarketData` (free) is
  the live impl; Massive / IBKR remain alternatives. Surface: stock snapshots, separate screeners,
  cached per-ticker daily `profiles`, and optional `dailyBars`; P5 grows calendar/options support.
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
- **`velocity`/`accel` are `null` without a real prior window.** W−1 remains provisional and is
  exact-refreshed with its signals; every successful cycle repairs/finalizes all eligible rows through
  W−2 so an outage cannot strand longitudinal history until restart.
- **Posts and comments are independent coverage requirements.** Either partial/stale/no-data kind
  discards radar scoring whole; every attempt remains in `ingestion_runs`, while raw rows and mentions
  from an independently successful kind are retained. A cap is publishable but low-trust and surfaced.
- **Removed/deleted source content does not score.** First-seen text/mention provenance remains. Stable
  repairs detect newer removal observations, replay forward, and restamp `repaired_at`,
  `repair_version`, `scoring_version`, total mentions, and quiet state.
- **Missing whitelist fails CLOSED to cashtag-only**, never to bare-token extraction. Ambiguous
  instrument/common tokens require trading context; `heat-extract-eval` pins labeled precision/recall.
- **`rvol` / `ret` remain day-to-date, NOT window-aligned**, so lead-lag stays disabled. `H_m` is now
  stable per ticker: volatility-scaled return + same-session-progress rvol, fixed caps, true source
  timestamps, and `null` when no timestamped component exists. IEX volume remains low-confidence.
- **Quadrants require both axes, a populated rolling split, and per-row distinct-author support.**
- **Every cycle persists `scoring_version`;** historical analysis reads only explicit finalized rows.
- **Outcome/P&L stays per-post — never aggregate to a per-ticker win rate** (survivorship bias).
- **Arctic-Shift is the sole live tap.** Don't publish stale signals.

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
