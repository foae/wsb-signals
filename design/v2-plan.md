# v2 — Full-stack TypeScript Plan

> **Status:** v2 is **BUILT — all slices (0–10) complete**, including the slice-8 Nuxt web. This doc is
> the blueprint + the as-built record. Supersedes the hybrid
> `nuxt-migration.md`. Parity details live in [`v2-porting-spec.md`](./v2-porting-spec.md); the
> concept/math/non-negotiables remain [`signal-framework.md`](./signal-framework.md) +
> [`architecture.md`](./architecture.md). Frozen reference = `git tag v0.0.1`.
>
> **⚰ HISTORICAL as of the Plays P0 prune (2026-08-18).** This doc describes the repo **as it was
> during the v2 port** — several statements below no longer hold on `main`: the Python tree is no
> longer "in-tree at root, untouched" (pruned; tags `v0.0.1`/`oracle-final`), the `--shadow` /
> `shadow-diff` commands are gone (gate passed and retired; porting-spec §12 tombstone), the root
> `docker-compose.yml`/`deploy/README.md` are deleted, and the web service is built and shipped in
> `deploy/v2/` (not deferred). For the current tree read `CLAUDE.md` and `design/plays-plan.md`;
> this doc is kept as the port's design/decision record.

## 0. Decision & scope

- **v0.0.1 is frozen** (Python + DuckDB + Streamlit, tagged, deterministic). It is the **parity
  oracle**, not a thing to maintain.
- **v2 = a full-stack TypeScript application.** The **entire worker** (Arctic-Shift ingestion,
  extraction, classification, `H_e`/`H_m` scoring, the Alpaca client) is re-implemented in TS as a
  **standalone Node process**; the frontend is **Nuxt 4 SSR**; storage is **Postgres**; one **pnpm
  monorepo** with a shared Drizzle schema. v2 scope = **v0.0.1 feature parity** + the v0.0.2 analytical
  signals (divergence / quadrants / lead-lag — simple stats, also TS). History views land as **tables**
  (charts deferred). LLM/NLP track stays out (if it returns, it's a narrow Python sidecar).
- **Why B (single language), honestly:** a solo dev pays the two-language context-switch tax alone, so
  one stack end-to-end is the goal. **8/8 reviewers across two panels judged the hybrid (A′) lower-risk
  for the same end-state** — B buys no new functionality at parity and front-loads the I/O re-port. B
  was chosen as a deliberate **single-language preference**, executed behind the parity oracle and the
  gates in `v2-porting-spec.md` so the risk is contained, not hand-waved.

## 1. Architecture / topology

```
  Arctic-Shift ─┐
                ├─►  WORKER (standalone Node/TS, own container)            ┐
  Alpaca ───────┘      poll → extract → classify → H_e → H_m → analytics  │ writes (atomic per cycle)
                                                                           ▼
                                        Postgres  ◄── reads (complete windows only) ── WEB (Nuxt 4 SSR)
                                     (Drizzle schema, shared)
```

- **Worker:** the v0.0.1 5-min loop, in TS — a long-running process, **not** a Nitro task (no
  event-loop coupling, no overlap). Single writer. Owns DDL/migrations.
- **Web:** read-only Nuxt 4 SSR; reads Postgres directly; route-cached to the ~5-min cadence; banners
  stale/quiet/capped/incomplete states (never serves a polished-but-dead board).
- **Postgres:** the only integration seam; epochs stay `BIGINT` (see porting-spec §6).
- One database, two Node processes (worker + web), **one language**.

## 2. Monorepo layout (pnpm workspace)

```
wsb-signals/
├─ wsb_signals/, tests/, design/, …   the FROZEN v0.0.1 Python radar (the oracle; untouched)
├─ pnpm-workspace.yaml, package.json, tsconfig.base.json, .nvmrc
├─ packages/
│  ├─ shared/        Drizzle schema + inferred types, Zod schemas, config loader, pure helpers
│  ├─ worker/        the TS radar: clients (arctic-shift, alpaca), extract, classify, aggregate,
│  │                 market, the loop, migrations runner; depends on shared
│  └─ web/           Nuxt 4 app (SSR pages + Nitro API routes); depends on shared (read-only)
├─ fixtures/         golden parity fixtures dumped from the v0.0.1 oracle (B1–B5, porting-spec §1)
└─ deploy/           Dockerfiles + compose (db + worker + web)
```

The Python tree stays at root, untouched — it's the oracle. `shared/` is the **one** place the schema
and types are defined; worker and web both import it (the single-language payoff).

## 3. Stack & locked choices

| Concern | Choice | Notes |
|---|---|---|
| Runtime | **Node 24 LTS**, **pnpm** | pinned via `.nvmrc` + `engines`. |
| Language | **TypeScript strict** | `vue-tsc`/`tsc` in CI. |
| DB | **Postgres** (plain) | epochs `BIGINT`; `flair_counts` `JSONB`. |
| ORM / schema | **Drizzle** (+ `drizzle-kit` migrations) | schema in `shared/`; worker migrates, web never does. |
| HTTP client | **`undici`/`fetch`** (manual status check) | must NOT throw on 4xx/5xx (porting-spec §4). |
| Worker scheduling | **standalone loop** (`while`+`await sleep`) | advisory lock + PID file; SIGTERM graceful. |
| Validation | **Zod** | DB read results + API I/O. |
| Web framework | **Nuxt 4** (Nitro, Vue 3, SSR universal + route rules) | |
| UI | **Nuxt UI** | Table/Badge/Card/Banner. |
| HTML validation | **`@nuxtjs/html-validator`** | SSR markup in dev/build. |
| Tests | **Vitest** + **fast-check** (property parity) + **testcontainers-node** (PG) | mock server for I/O faults. |
| Lint | **`@nuxt/eslint` flat + Stylistic** | |
| Logging | **consola** (web) / **pino** (worker) | structured, fields matching the Python logger for shadow diffing. |
| Read/write roles | worker = writer role; web = **read-only** role | separate connection factories. |

> **Verify-on-implement:** ~~Nuxt 4 + Nuxt UI + pnpm settings~~ **VERIFIED in slice 0** — Nuxt 4.4.7 +
> Nuxt UI 4.8.2 (note: **v4**, not the v3 the earlier draft assumed) install, `nuxt prepare`, typecheck,
> and a full SSR build are green under pnpm 11 (the native builds it needs are approved in
> `pnpm-workspace.yaml`). `@nuxtjs/html-validator` **VERIFIED compatible** with Nuxt 4 + Nuxt UI v4 in
> slice 8 (full SSR build green with it enabled). Drizzle's batch-insert param handling under the 65535
> cap was resolved in slice 3 (≤1000-row chunking, porting-spec §6).

## 4. Build order (pure-logic-first, each slice gated on the oracle)

Reordered per the review — port the cheap, deterministic, no-I/O logic first so the scoring is proven
before live data flows; the riskiest I/O comes last, when any anomaly is isolated to it.

> **Status: ALL SLICES COMPLETE (0–10).** The headless data pipeline shipped first (M1–M5); the Nuxt
> web (slice 8) — the last slice — is now **DONE** (M6 below). The full stack (db + worker + web) is
> built and deployable. Milestones:
> - **M1 — process + insert (slices 2–3):** mentions → `H_e` features **written to Postgres**,
>   oracle-gated, round-tripped on testcontainers. The empirical path is computable **and** persistable.
> - **M2 — live + automated (slices 4–6):** Arctic-Shift ingest, Alpaca `H_m` overlay, the 5-min loop
>   with atomic per-cycle publish, SIGTERM, advisory lock. The worker runs unattended.
> - **M3 — new signals (slice 7): DONE.** divergence / quadrants / lead-lag computed + persisted to
>   `signals` each cycle (atomic publish). NEW code, no oracle — gated by its own unit + integration tests
>   (see porting-spec §11 for the fixed semantics).
> - **M4 — live parity (slice 9): DONE + GATE PASSED (2026-06-08/09).** Deterministic **replay-vs-oracle**
>   shadow: the live TS worker (`--shadow`) captures each cycle's exact scorer inputs + board;
>   `oracle/replay.py` replays them through the frozen `aggregate_window`; `shadow-diff` asserts value+order
>   parity (exit non-zero on DRIFT) — the cutover gate. **Ran it live: 4 hourly windows all `MATCH`, 0
>   DRIFT, all read-backs ok, ITs 70/70** — all three §12 legs met, and the §4.1 ingest retry handled a real
>   422-throttle + overnight network outage cleanly. **v2 is cutover-approved as the radar** (porting-spec
>   §12 "EXECUTED"). Supersedes the "two live pollers into separate tables" framing (independent polls fetch
>   different data ⇒ un-gateable). Semantics authoritative in porting-spec **§12**.
> - **M5 — ship headless (slice 10, interim): DONE.** `deploy/v2/` ships **db + worker** (2 services, 1
>   image): a Node/tsx worker image (migrates on boot, advisory lock, `heartbeat` healthcheck) + pinned
>   Postgres. Ported the two remaining `also-port` CLIs — `build-whitelist` (`assets.ts`) and `heartbeat`
>   (exit 0/1/2) — and bounded the z-baseline read to a trailing window (porting-spec §2.7) so a
>   long-running worker's `feature_history` read stays O(lookback).
> - **M6 — web board (slice 8): DONE.** Nuxt 4 SSR read-only board: `GET /api/board` reads the latest
>   COMPLETE cycle in ONE read-only REPEATABLE READ transaction (snapshot-isolated against the worker's
>   per-window republish), LEFT-joins empirical⋈signals⋈analytical⋈ticker_names, sorts in JS via the
>   hoisted `@wsb/shared` `compareBoard` (H_m/divergence/quadrant sourced from `signals`, not analytical).
>   Leaderboard + movers + quiet/capped/stale/empty/no-data banners + methodology copy. Read-only PG role
>   provisioned idempotently on **worker boot** (`ensure-read-role.ts`; initdb can't fix the existing
>   volume). `deploy/v2/` now ships **db + worker + web** (3 services). Gated by a testcontainers read-path
>   IT (`packages/web/test/board.it.test.ts`) + the worker role-provisioning IT. Cross-model review-gated.
>
> **Review gate (mandatory):** at the end of each milestone (M1–M6), run a cross-model review
> (`/second-opinion` or `/multi-llm-review`) over the work since the last gate — catch parity/
> architecture drift before building further. Synthesize, fix real findings, then advance.

0. **Scaffold + oracle harness.** pnpm monorepo; `shared/` Drizzle schema (port `db.py SCHEMA`); a
   Python dump-harness on the `v0.0.1` tag that emits golden fixtures at boundaries B2–B5
   (porting-spec §1). Vitest + testcontainers wired.
1. **Extract + classify** (pure). Port `extract.py`/`classify.py`; property-parity + adversarial
   fixtures (porting-spec §3, §9). Green in hours.
2. **Aggregate `H_e`** (pure, highest-risk math). Port `aggregate.py`; deep-equality parity (values
   **and** order) on fixture mention sets (porting-spec §2). Port the v0.0.1 unit tests to Vitest first.
3. **Schema + persistence.** Drizzle upserts with exact per-table `ON CONFLICT`, ≤1000-row chunking,
   atomic per-cycle publish (porting-spec §6). Round-trip test on testcontainers PG.
4. **Ingestion client** (riskiest I/O). Port Arctic-Shift; VCR + **fault-injection** mock server for
   `ok`/`capped` semantics (porting-spec §4).
5. **Market client + `H_m`.** Port Alpaca snapshots/screeners + `compute_analytical` (porting-spec §5).
6. **Worker loop.** Assemble the cycle (poll→…→publish), lifecycle (SIGTERM, advisory lock, throttle,
   W−1-before-W) (porting-spec §7).
7. **Analytics (new) — DONE.** divergence / quadrants / lead-lag from the stored series — fresh TS, no
   port (the frozen radar never populated `signals`). Semantics fixed in porting-spec §11: divergence =
   `H_e − H_m`; quadrant split = **global rolling median** of H_e/H_m over the trailing overlaid cells
   (strictly-above = hot); lead-lag = argmax normalized cross-correlation (k>0 ⇒ WSB leads). Screener-
   movers ∖ WSB-hot STEALTH discovery deferred (stays captured in `market_movers`).
8. **Web — DONE (board-only).** Nuxt 4 SSR read-only leaderboard + movers + quiet/capped/stale/empty/
   no-data banners + methodology copy. `GET /api/board` (Zod-validated) reads the latest COMPLETE cycle
   in ONE read-only REPEATABLE READ transaction (snapshot-isolated), LEFT-joins
   empirical⋈signals⋈analytical⋈ticker_names, sorts in JS via `@wsb/shared` `compareBoard`
   (H_m/divergence/quadrant from `signals`, ret/rvol from analytical). Route-cached (60s SWR). Read-only
   PG role provisioned on worker boot (`ensure-read-role.ts`). `@nuxtjs/html-validator` green under Nuxt
   4. Gated by a testcontainers read-path IT. **History tables / trends / lead-lag display were scoped
   OUT** (board-only); they can land as a follow-up if wanted.
9. **Live shadow → cutover — DONE.** Deterministic **replay-vs-oracle** (porting-spec §12): the live TS
   worker `--shadow`-dumps each cycle's exact scorer inputs + board (B3+B4); `oracle/replay.py` replays
   them through the frozen oracle; `shadow-diff` asserts value+order parity (MATCH/NEAR/DRIFT, exit
   non-zero on DRIFT) — **needs no web, no second live poller, no DB-row diff**. Cut over only when no
   DRIFT holds over a sustained window. (The earlier "beside the radar into separate tables" framing is
   superseded — independent live polls fetch different data, so they can't gate exact parity.)
10. **Deploy — DONE.** `deploy/v2/` now ships **db + worker + web** (3 services). The headless db+worker
    shipped first (interim M5); the `web` service (Nuxt SSR, read-only role) landed with slice 8 (M6).

## 5. Data flow & publication

- **Single writer** (worker), **atomic per-cycle publish** (one transaction over empirical + analytical
  + movers, and/or a `run_status`/`cycle_runs` marker). Any reader takes the latest **complete**
  `window_start` only — never a half-written cycle (porting-spec §6). Built now for the **shadow-diff**
  (slice 9) and a future web — it's correctness, not a UI concession.
- **Freshness:** the worker persists each cycle's freshness/`capped`/`quiet` state so a reader (the
  shadow-diff now, the web later) can tell a degraded/stale cycle from a healthy one (architecture §5).

## 6. Deployment

**Interim (headless): 2 services, 1 image** — db + worker, in **`deploy/v2/`** (`compose.yml` +
`worker.Dockerfile` + `entrypoint.sh` + `.env.example` + `README.md`). The `web` service is added when
slice 8 lands.
```
db      postgres:<pinned>          named volume; pg_isready healthcheck
worker  wsb-worker (Node image)    the writer; the poll loop; runs migrations on boot; advisory lock;
                                    healthcheck = a freshness/heartbeat probe; depends_on db healthy
web     wsb-web (Node image)       DEFERRED (slice 8) — built Nuxt server (node .output/server/index.mjs),
                                    read-only DB role, binds 0.0.0.0:3000, depends_on db healthy
```
Carry over the Incus host-networking note (worker needs egress to Arctic-Shift/Alpaca). Secrets via
`env_file`; nothing baked into images. The frozen Python radar is **not** deployed (oracle only).

## 7. Config & secrets

- Worker: `DATABASE_URL` (writer role) + `ALPACA_*`. The v0.0.1 tunables (`config.toml` §2–§5 of the
  porting-spec) move into a typed `shared/` config (TOML or TS) — one source, imported by worker (and
  by web for the few it needs, e.g. `min_window_mentions` for the quiet banner).
- Web: `DATABASE_URL` (a **read-only** role) only — no Alpaca/Arctic creds.
- `.env` gitignored; never commit keys. `whitelist/symbols.txt` is derived (built by the ported
  `build-whitelist`), gitignored, lives with the worker; `stoplist.txt`/`ambiguous.txt` are committed.

## 8. Open items (verify on implement)

- ~~Nuxt 4 / Nuxt UI / pnpm settings~~ — **resolved in slice 0** (Nuxt 4.4.7 + Nuxt UI **4.8.2**, SSR
  build green). ~~`@nuxtjs/html-validator` compatibility~~ — **resolved in slice 8** (green under Nuxt 4).
- ~~Drizzle batch-upsert parameter behavior under the 65535 cap~~ — **resolved in slice 3** (≤1000-row chunking).
- ~~The exact `run_status`/publish-marker shape~~ — **resolved in slice 3** (`cycle_runs`, status='complete').
- ~~**Still open:** ROADMAP 0.6 (peak-hour DDT pagination/throughput) transfers to the TS ingest~~ —
  **RESOLVED (2026-06-08/09).** The cutover-gate run confirmed the risk live: the heavy 1h comment backfill
  reliably trips Arctic-Shift's `422 "slow down"` throttle (heartbeat stays green ⇒ it's the heavy walk, not
  an outage). Mitigated by the **§4.1 ingest retry** (bounded backoff on transient failures), which also
  rode out an overnight network outage cleanly. `capped` was never hit (the 60-page cap is ample); the live
  failure mode was throttle/5xx, now retried.
- **Still open (deferred from slice 8):** history/trends/daily-rollup views and lead-lag display were
  scoped out of the board-only web; a `cycle_runs.window_seconds` column would make the web self-
  configuring (vs the current shared-constants↔config.toml env coupling) if that drift ever bites.
- **Shadow-diff caveat:** lead-lag persists null by default (`lead_lag.enabled=false`) until `H_m` is
  window-aligned (intraday bars) — porting-spec §11; the web omits the lead-lag column accordingly.
