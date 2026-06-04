# Storage + Frontend Migration Guide (DuckDB→Postgres, Streamlit→Nuxt)

> **Status:** plan, not yet built. Authoritative blueprint for the next iteration of WSB Signals.
> Decisions made in a design session (2026-06-04) and **revised after a four-model second-opinion
> review** the same day — see [§11](#11-what-the-review-changed).
>
> **This is NOT a full rewrite and NOT a "Nuxt monolith."** An earlier draft proposed re-implementing
> the whole pipeline in TypeScript; the review (4/4 reviewers) showed that front-loads the risk
> (porting a fragile, invariant-dependent scoring pipeline) for **zero new functionality** (v0.0.1 is
> pure parity). The chosen design instead:
>
> - **Keeps the proven Python radar unchanged** — ingestion, extraction, classification, the `H_e`/`H_m`
>   math, the poll loop. The unit-tested invariants stay exactly as they are.
> - **Swaps the store: DuckDB → plain Postgres** — so the web can read concurrently (this is the only
>   reason DuckDB was a problem; it was a *storage* lock, not a language issue).
> - **Replaces the Streamlit dashboard with a Nuxt 4 SSR frontend** that reads Postgres directly.
>
> [`signal-framework.md`](./signal-framework.md) and [`architecture.md`](./architecture.md) remain the
> source of truth for the concept, the math, and the **non-negotiables (architecture §5)**.

## 0. Scope & rationale

- **Target = v0.0.1 parity (Phase 0→2):** SoV radar → `H_e` → Alpaca stock overlay + screeners → a board.
- **Two changes only:** (1) storage DuckDB→Postgres in the Python radar; (2) a new Nuxt SSR frontend
  replacing Streamlit. **The pipeline code does not change.**
- **Greenfield, forward-only:** fresh Postgres DB, no backfill, no data migration from the DuckDB file.
- **Out of scope (v0.0.2 / Phase 3):** divergence, quadrants, STEALTH, lead-lag, alerts, per-ticker
  drill-down, charts. Those stay in Python when built — keeping the radar in Python preserves the
  data/NLP ecosystem (Polars/NumPy/LLM SDKs) those phases lean on.

> **Why not even simpler (keep DuckDB, point Nuxt at the existing `leaderboard.json` + `history.parquet`)?**
> That was on the table and is the lowest-effort variant. We chose the Postgres swap deliberately: it
> gives the frontend a real query surface (filtering, future drill-down) instead of a fixed snapshot
> contract, and removes the single-writer-lock workaround entirely. If effort needs to shrink further,
> the DuckDB+snapshot variant remains a valid fallback.

## 1. Architecture at a glance

```
  Arctic-Shift ─►┌───────────────────────────┐         ┌──────────────────────────┐
  Alpaca ───────►│  RADAR  (Python, retained) │ writes  │   WEB  (Nuxt 4 / Nitro)  │
                 │  the existing 5-min loop;   ├────────►│  SSR leaderboard;        │
                 │  poll→extract→classify→     │         │  reads Postgres directly │
                 │  aggregate→market→PERSIST    │         │  (read-only); HTML       │
                 │  (DuckDB swapped for PG)     │  reads  │  validated, route-cached │
                 └─────────────┬───────────────┘◄────────┴──────────┬───────────────┘
                               │                                     │
                               ▼                                     ▼
                 ┌──────────────────────────────────────────────────────────────────┐
                 │                  Postgres  (plain — no Timescale)                  │
                 └──────────────────────────────────────────────────────────────────┘
```

- The **radar is still the single writer** (no change to that logic). Postgres simply lets the web
  read concurrently — so the **JSON-snapshot + `history.parquet` contract is dropped** (it existed
  only to dodge DuckDB's exclusive lock).
- The **web is read-only.** It never writes; the schema is owned by the radar.
- Two languages, two images, one database. This is a **service split, not a monolith** — and that's
  the point: each half stays in the language that fits it.

## 2. What changes, what stays

| Component | Python file(s) | Action |
|---|---|---|
| Ingest | `sources/arctic_shift.py`, `sources/base.py` | **KEEP as-is.** (Rate-limit backoff, inter-page delay, `capped`/`ok` semantics all preserved — they're not being ported.) |
| Extract | `extract.py` | **KEEP as-is.** Whitelist file stays in the radar container exactly as today. |
| Classify | `classify.py` | **KEEP as-is.** |
| Aggregate / `H_e` | `aggregate.py` | **KEEP the math.** Remove only `write_snapshot` / `write_history` calls (no more JSON/Parquet). Epochs stay integer (`window_start_for` unchanged). |
| Market / `H_m` | `analytical.py`, `market/alpaca.py`, `market/base.py` | **KEEP as-is.** |
| Orchestrate | `cli.py` (`cmd_run`, etc.) | **KEEP**, minus the snapshot/Parquet writes and the `dashboard` subcommand. |
| Models / config | `models.py`, `config.py`, `config.toml` | **KEEP as-is.** |
| **Store** | `db.py` | **REWRITE: DuckDB → Postgres** (psycopg3). Schema + upserts port near-verbatim ([§4](#4-storage-swap-duckdb--postgres)). |
| Snapshot/Parquet | `aggregate.write_snapshot` / `write_history` | **DROP.** Web reads the DB directly. |
| Dashboard | `dashboard.py`, `cli.cmd_dashboard` | **DROP** (replaced by the Nuxt web). |
| **Frontend** | — | **NEW: Nuxt 4 SSR app** ([§5](#5-the-nuxt-web-app)). |

Everything in the radar except `db.py` and the snapshot/dashboard plumbing is untouched — so the
ported unit tests (`tests/test_aggregate.py`, `test_extract.py`, `test_history.py`) keep passing as-is,
and the §5 invariants are preserved **by construction**, not by careful re-implementation.

## 3. Stack & locked decisions

| Concern | Choice | Notes |
|---|---|---|
| Radar language | **Python (retained)** | `uv`, the existing `wsb` CLI — unchanged. |
| **Database** | **plain Postgres** | no TimescaleDB ([§11](#11-what-the-review-changed)); add it later only if rollups/compression pay off. |
| Radar ↔ DB | **psycopg3 (sync)** | matches the sync `time.sleep` loop + batched `executemany` `ON CONFLICT` upserts. |
| Schema ownership | **the radar** (`wsb init-db`) | web is a pure reader; one source of DDL. |
| Web framework | **Nuxt 4** (Nitro, Vue 3, **SSR universal** + route caching) | |
| Web ↔ DB | **`postgres.js` + Zod-validated reads** | read-only; ~3 queries. Drizzle (introspected via `drizzle-kit pull`) is the typed-query-builder alternative if preferred. |
| Web runtime | **Node 24 LTS**, **pnpm** | pinned via `.nvmrc` + `engines`. |
| UI | **Nuxt UI** (`@nuxt/ui`) | Table/Badge/Card/Banner. |
| HTML validation | **`@nuxtjs/html-validator`** | validates rendered SSR HTML in dev/build (the markup side of "validation"). |
| Data validation | **Zod** | validate DB query results + any API I/O in the web. |
| Lint/format | **`@nuxt/eslint` flat config + ESLint Stylistic** | web only; the radar keeps its existing (no-lint) setup. |
| Web tests | **Vitest** (+ `@nuxt/test-utils`) | radar tests stay **pytest**. |
| Logging (web) | **consola** | readable under `docker compose logs`. |
| TypeScript | **strict** | Nuxt's generated tsconfig; `vue-tsc` in CI. |

**Nuxt modules (web):** `@nuxt/eslint`, `@nuxt/ui`, `@nuxtjs/html-validator`, `@nuxt/test-utils`.

> **Verify-on-implement (medium confidence at planning time):** Nuxt-4 compatibility of
> `@nuxtjs/html-validator`; the current Nuxt UI v3 API; the pnpm settings Nuxt 4 needs.

## 4. Storage swap: DuckDB → Postgres

The schema in `db.py` (`SCHEMA`, mirroring [architecture §2.7](./architecture.md)) ports to Postgres
almost verbatim. **Keep epoch columns as `BIGINT`** — do *not* convert to `timestamptz`. The
aggregation math uses integer epoch floor division (`window_start_for = (now // window_seconds) *
window_seconds`); keeping `BIGINT` means **zero math changes and no window-boundary risk**.

Type mapping:

| DuckDB | Postgres | Notes |
|---|---|---|
| `VARCHAR` | `TEXT` | |
| `BIGINT` / `INTEGER` / `DOUBLE` | `BIGINT` / `INTEGER` / `DOUBLE PRECISION` | epochs stay `BIGINT`. |
| `flair_counts VARCHAR` (JSON string) | `JSONB` | use psycopg's `Json` adapter. |
| `PRIMARY KEY (...)` | identical | plain Postgres — **no hypertable partition-key constraint**, so all existing PKs (`id`, `(ticker, thing_id)`, `(ticker, window_start)`, …) carry over unchanged. |

Upserts: psycopg3 uses `%s` placeholders and `EXCLUDED` in `ON CONFLICT` — otherwise identical to the
DuckDB statements. **Preserve the per-table conflict semantics exactly:** `raw_posts`/`raw_comments`
`DO UPDATE` (refresh `score`/`num_comments`/`retrieved_on` on re-fetch), `mentions` **`DO NOTHING`**
(keep first-seen), `*_features`/`market_movers`/`ticker_names` `DO UPDATE`. Keep them **batched**
(`cursor.executemany(...)`) — the DDT firehose is thousands of comments per cycle.

Indexes (plain B-tree, sufficient at this volume): `mentions(created_utc)`, `empirical_features(window_start)`,
`analytical_features(window_start)`. The existing PKs cover the rest.

Drop from the radar: `export_history_parquet`, `write_snapshot`, `write_history`, the Streamlit
launcher. The radar now writes **only to Postgres**.

**Atomic publication (the one new concern):** the web reads while the radar writes. Two safeguards,
both cheap: (1) each table's per-cycle upsert is a **single batched statement** → atomic in Postgres,
so a reader never sees a half-written `empirical_features` set; (2) the web reads **the latest
`window_start` present in `empirical_features`** and LEFT-JOINs `analytical_features` on
`(ticker, window_start)` — so it can't mix cycles, and the (intentionally sparse, top-N-only)
analytical rows simply fill in as they land. Optionally wrap the cycle's writes in one transaction for
a clean publish boundary.

## 5. The Nuxt web app

Read-only SSR frontend, the only genuinely new code.

- `server/api/leaderboard.get.ts` (Nitro) — `postgres.js` query: latest `window_start` from
  `empirical_features` ⨝ `analytical_features` ⨝ `ticker_names`, ordered by `h_e DESC`; plus window
  meta (`total_mentions`, the `quiet` flag when `total_mentions < heat.min_window_mentions`) and the
  `market_movers` for that cycle. Validate the result rows with **Zod**.
- `app/pages/index.vue` — SSR leaderboard table, columns per [signal-framework §8](./signal-framework.md):
  `ticker | name | sov | mentions | authors | vel | accel | net_dir | z | base | H_e ‖ ret | rvol | H_m`,
  the screener-movers teaser, and the **low-confidence banner** when the window is `quiet`.
- **Rendering:** SSR universal; cache/SWR the board route to the ~5-min cadence (Nitro route rules) so
  Postgres isn't hit per request.
- **Staleness surfacing (preserve "never publish stale", architecture §5):** the radar already logs
  freshness each cycle; persist the latest freshness state (a small `meta`/`run_status` row) and have
  the web **banner a stale/degraded state** rather than silently serving a cached board.
- **HTML validation:** `@nuxtjs/html-validator` checks the rendered SSR markup in dev/build.
- **Secrets:** the web needs only `DATABASE_URL` (read-only role recommended). It does **not** touch
  Alpaca/Arctic-Shift — only the radar does.

## 6. Repo layout

Keep the existing Python tree at root; add the web app under `web/`:

```
wsb-signals/
├─ wsb_signals/            Python radar (unchanged except db.py + removed snapshot/dashboard)
├─ tests/                  pytest (unchanged)
├─ config.toml, pyproject.toml, uv.lock   (drop the streamlit dependency)
├─ web/                    ★ NEW — Nuxt 4 app
│  ├─ nuxt.config.ts, eslint.config.mjs, package.json, .nvmrc
│  ├─ app/pages/index.vue, app/components/…
│  ├─ server/api/leaderboard.get.ts, server/utils/db.ts (postgres.js client)
│  └─ tests/               Vitest
├─ deploy/                 Dockerfiles + compose (radar + web + postgres)
└─ design/                 source of truth (this file lives here)
```

## 7. Config & secrets

- **Radar:** unchanged — `config.toml` (tunables) + `.env` (`ALPACA_*`), `config.py` overlaying
  `os.environ`. Add `DATABASE_URL` (or `PG*` parts) for the radar's writer connection.
- **Web:** Nuxt `runtimeConfig` reads `DATABASE_URL` (a **read-only** Postgres role) from `.env`. No
  Alpaca creds. Tunables the web needs (e.g. `min_window_mentions` for the banner threshold) come from
  the DB/meta or a small typed web config — don't duplicate the radar's `config.toml`.
- `.env` gitignored; `whitelist/symbols.txt` stays derived/gitignored **inside the radar** (no
  cross-container concern — the web never reads it). **Never commit API keys.**

## 8. Deployment

Three services, **two images**:

```
db      postgres:<pinned>            named volume (PGDATA); pg_isready healthcheck
radar   wsb-signals (Python image)   the writer; `wsb run`; healthcheck `wsb heartbeat` (exit 0/1/2);
                                      depends_on db healthy; runs `wsb init-db` once on first boot
web     wsb-web (Node image)         built Nuxt server (`node .output/server/index.mjs`);
                                      depends_on db healthy; binds 0.0.0.0:3000; reads DATABASE_URL
```

- **Radar image:** the existing `Dockerfile` minus the `streamlit` dependency; add `psycopg[binary]`.
- **Web image:** standard multi-stage Nuxt build → ship the self-contained `.output` (slim; no source,
  no tsx — the web is built, the radar is the only Python process).
- **Schema/migrations:** the radar owns DDL via `wsb init-db` (greenfield). If schema versioning is
  wanted later, add a lightweight Python migration step; the web does not migrate.
- **Networking:** carry over the current **Incus host-networking** note (radar needs egress to
  Arctic-Shift/Alpaca; web binds `0.0.0.0:3000`). On a standard bridge host, publish the web port
  normally.
- Secrets via shared `.env` (`env_file`); nothing secret baked into either image.

## 9. Testing

- **Radar:** existing **pytest** suite runs unchanged (the pipeline didn't change). Add a thin test
  that `db.py` round-trips against a disposable Postgres (testcontainers or a CI service) — the only
  new radar code.
- **Web:** **Vitest** (+ `@nuxt/test-utils`) — Nitro-route tests against a seeded Postgres and an
  SSR-render test of the board; `@nuxtjs/html-validator` covers markup validity in dev/build.

## 10. Invariants checklist (architecture §5)

Most are preserved **automatically** because the radar is retained. The ones that need attention in
this migration are marked ⚠.

- [ ] Rank on `sov`, never raw counts / cold-start `z`; `z` gated until baseline `ready`; baselines
      forward-only. *(unchanged — Python math retained)*
- [ ] Components max-normalized within window, not percentile-ranked. *(unchanged)*
- [ ] `velocity`/`accel` `null` with no real prior window. *(unchanged)*
- [ ] Partial poll (`ok == False`) discarded whole; **`capped` window persisted but logged low-trust**.
      *(unchanged — `arctic_shift.poll` semantics retained)*
- [ ] W−1 re-finalized before the current window each cycle. *(unchanged)*
- [ ] Missing whitelist fails closed to cashtag-only; ambiguous gate needs trading context. *(unchanged)*
- [ ] `rvol`/`ret` day-to-date not window-aligned; `rvol` low-confidence on IEX; `feed`/`as_of` stamped. *(unchanged)*
- [ ] Market overlay best-effort — never kills the loop. *(unchanged)*
- [ ] Outcome/P&L per-post — never aggregated to a per-ticker win rate. *(unchanged)*
- [ ] ⚠ **Arctic-Shift sole live tap; heartbeat alarms; never publish stale** — preserve by surfacing
      the radar's freshness/down state in the **web** (banner), not just in radar logs ([§5](#5-the-nuxt-web-app)).
- [ ] Support shrink keeps thin-evidence rows off the top. *(unchanged)*
- [ ] ⚠ **Never commit API keys** — radar keeps `.env`; the web gets a separate **read-only** DB role.
- [ ] ⚠ **Keep `design/` and code in sync** — `db.py`'s Postgres schema must still match architecture §2.7.

## 11. What the review changed

A four-model second-opinion review (Codex/gpt-5.5, Gemini, DeepSeek, Qwen) reshaped the original
full-TS-rewrite plan:

- **Dropped TimescaleDB → plain Postgres.** 4/4 reviewers judged Timescale over-engineered at this
  volume, and a concrete blocker was found: Timescale requires PK/unique constraints to include the
  partition column, which `raw_posts(id)`, `raw_comments(id)`, and `mentions(ticker, thing_id)` don't —
  hypertabling them would break the idempotent `ON CONFLICT` upserts. Plain Postgres avoids this and
  still removes the single-writer lock (the actual goal).
- **Dropped the full TS rewrite → hybrid (retain the Python radar).** All four flagged that porting a
  fragile, invariant-dependent pipeline to TS for *zero new functionality* front-loads risk. Retaining
  Python eliminates, by construction, the review's biggest concrete risks: Python↔TS scoring drift, the
  needed gold-file parity test, re-porting the Alpaca rate-limit/backoff + inter-page delay, `capped`
  handling, batch-upsert semantics, and the `time_bucket`/epoch-conversion correctness question.
- **Net:** the remaining work is a contained storage swap + a new read-only frontend, not a rewrite.

## 12. Build order

1. **Postgres up:** local `postgres` container; define `DATABASE_URL`.
2. **Port `db.py` to psycopg3:** schema DDL + the upsert methods (preserve conflict semantics); drop
   the Parquet export. Remove `write_snapshot`/`write_history` calls and the `dashboard` subcommand.
   Verify the radar runs end-to-end against Postgres (`wsb init-db`, `wsb run --once`, `wsb market`),
   and the **pytest suite still passes**.
3. **Scaffold the web:** Nuxt 4 + pnpm + TS strict + the module set; `postgres.js` client; `.env` with
   the read-only `DATABASE_URL`.
4. **Leaderboard route + page:** `server/api/leaderboard.get.ts` (Zod-validated) + `app/pages/index.vue`
   (SSR, Nuxt UI table, quiet banner, staleness banner); route caching; `@nuxtjs/html-validator` green.
5. **Deploy:** two Dockerfiles + 3-service compose (db/radar/web), heartbeat healthcheck, host-networking
   note.

**Exit (v0.0.1 parity):** the retained Python radar writes to Postgres; a Nuxt SSR board reads it live —
feature-equivalent to today's leaderboard + Alpaca overlay + screeners, minus the deferred v0.0.2
product, with the dashboard now a real web frontend instead of Streamlit.
