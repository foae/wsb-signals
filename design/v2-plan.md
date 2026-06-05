# v2 — Full-stack TypeScript Plan

> **Status:** authoritative blueprint for v2 (not yet built). Supersedes the hybrid
> `nuxt-migration.md`. Parity details live in [`v2-porting-spec.md`](./v2-porting-spec.md); the
> concept/math/non-negotiables remain [`signal-framework.md`](./signal-framework.md) +
> [`architecture.md`](./architecture.md). Frozen reference = `git tag v0.0.1`.

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
> `pnpm-workspace.yaml`). Still open: `@nuxtjs/html-validator` compatibility (slice 8) and Drizzle's
> batch-insert param handling under the 65535 cap (slice 3, porting-spec §6).

## 4. Build order (pure-logic-first, each slice gated on the oracle)

Reordered per the review — port the cheap, deterministic, no-I/O logic first so the scoring is proven
before live data flows; the riskiest I/O comes last, when any anomaly is isolated to it.

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
7. **Analytics (new).** divergence / quadrants / lead-lag from the stored series — fresh TS, no port.
8. **Web.** Nuxt SSR leaderboard + history **tables** + banners (quiet/capped/stale); Nitro read routes
   (Zod-validated, complete-window reads); route caching; `@nuxtjs/html-validator` green.
9. **Live shadow → cutover.** Run TS worker beside the frozen Python radar into separate tables; diff
   cycle-by-cycle; cut over only when parity holds (porting-spec §9).
10. **Deploy.** Two images, 3-service compose.

## 5. Data flow & publication

- **Single writer** (worker), **atomic per-cycle publish** (one transaction over empirical + analytical
  + movers, and/or a `run_status`/`cycle_runs` marker). The web reads the latest **complete**
  `window_start` only — never a half-written cycle (porting-spec §6).
- **Freshness:** the worker persists each cycle's freshness/`capped`/`quiet` state; the web banners
  degraded states instead of letting route caching hide a stale or dead worker (architecture §5).

## 6. Deployment

Three services, two images:
```
db      postgres:<pinned>          named volume; pg_isready healthcheck
worker  wsb-worker (Node image)    the writer; the poll loop; runs migrations on boot; advisory lock;
                                    healthcheck = a freshness/heartbeat probe; depends_on db healthy
web     wsb-web (Node image)       built Nuxt server (node .output/server/index.mjs); read-only DB role;
                                    binds 0.0.0.0:3000; depends_on db healthy
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
  build green). `@nuxtjs/html-validator` compatibility still open (slice 8).
- Drizzle batch-upsert parameter behavior under the 65535 cap (slice 3).
- The exact `run_status`/publish-marker shape (slice 3).
- ROADMAP 0.6 (peak-hour DDT pagination/throughput) is still open and **transfers** to the TS ingest —
  validate during the live shadow (slice 9).
