# CLAUDE.md

Contributor guidance for working with this repository.

WSB Signals is a near-live r/wallstreetbets "trending radar": poll Reddit, rank tickers by
**share-of-voice → WSB Heat `H_e`**, overlay Alpaca market data → **Market Heat `H_m`**, and
(eventually) badge the divergence between chatter and market action. It is observational research,
**not** a trading signal — keep that framing in any user-facing copy.

## ⚠ Version state — READ THIS FIRST

**This branch (`main`) is v0.0.1 — FROZEN.** The Python + DuckDB + Streamlit radar described in this
file is tagged `v0.0.1`, stable, deterministic, and feature-frozen. It is the **parity oracle** for v2;
don't add features to it here.

**Active development is v2 — a full-stack TypeScript rewrite** (the whole worker re-implemented in TS, a
Nuxt 4 SSR frontend, Postgres, a pnpm monorepo). It lives on branch **`feat/v2-fullstack-nuxt`** —
**`git switch feat/v2-fullstack-nuxt`** for all new work and the authoritative v2 docs (`design/v2-plan.md`
+ `design/v2-porting-spec.md` exist on that branch, not here). The rest of this file describes the frozen
v0.0.1 radar.

## Source of truth

The `design/` docs are authoritative; code references them by section number (e.g. "signal-framework §4").
When you change behavior, **keep the doc and the code in sync** — drift here is a real bug (the regex
comment in `extract.py` and `architecture.md` §2.2 calls this out explicitly).

- `design/signal-framework.md` — the concept: two signal families, normalization, `H_e`/`H_m`,
  divergence quadrants, lead-lag. **Read this first to understand *why*.**
- `design/architecture.md` — pipeline, components (§2), schema (§2.7), cadence (§3), the
  **non-negotiables** (§5). Maps almost 1:1 onto `wsb_signals/` modules.
- `ROADMAP.md` — phase plan & locked decisions. **v0.0.1 = Phase 0→2** (SoV radar + stock overlay +
  screeners — DONE; options enrichment of `H_m` is the remaining v0.0.1 increment). **v0.0.2 = Phase 3**
  (divergence quadrants, STEALTH detection, lead-lag — not built yet).
- `sources/` — per-provider API references and the data-access strategy.

## Commands

Tooling is **uv** (no manual venv / pip). Console entrypoint is `wsb` (`pyproject` → `wsb_signals.cli:main`).

```bash
uv sync                              # build env from pyproject + uv.lock
uv run --extra dev pytest            # run the test suite (pytest is in the `dev` extra, NOT default sync)
uv run --extra dev pytest tests/test_aggregate.py::test_support_damp_shrinks_thin_rows  # single test
uv run wsb init-db                   # create the DuckDB schema at data/wsb.duckdb
uv run wsb build-whitelist           # fetch Alpaca asset universe → whitelist/symbols.txt + ticker_names
uv run wsb run                       # THE RADAR: continuous poll → H_e → market overlay → snapshot
uv run wsb run --once --no-market    # single empirical-only cycle (handy for local checks)
uv run wsb aggregate                 # one-shot H_e board from stored mentions (no market)
uv run wsb market                    # one-shot aggregate + Alpaca overlay + screeners
uv run wsb poll-once                 # single poll → RAW mention count (smoke check, NOT the SoV signal)
uv run wsb eval-extractor            # extractor decision mix over a live window (precision proxy)
uv run wsb heartbeat                 # Arctic-Shift freshness probe; exits 0 OK / 1 stale / 2 down
uv run wsb dashboard                 # Streamlit board on :8501 (reads the JSON/Parquet, never the DB)
```

There is **no lint config** in-repo (no ruff/flake8), despite `# noqa` comments in the source.
Run-for-real is Docker Compose (`docker compose up -d --build`); see `deploy/README.md`.

## Pipeline (data flow)

`Reddit tap → extract tickers → classify direction → window-aggregate (H_e) → gate market data to
top-N hot → overlay (H_m) → JSON snapshot + Parquet → dashboard`. Module map:

| Stage | Module | Notes |
|---|---|---|
| Ingest | `sources/arctic_shift.py` behind `sources/base.py` `Source` | Paginated descending poll; only live tap. |
| Extract | `extract.py` | Regex candidates → stoplist → whitelist → ambiguous-context gate. |
| Classify | `classify.py` | Direction (bull/bear) from options/position words — **not** ironic sentiment. |
| Aggregate | `aggregate.py` | `mentions` → `(ticker, window)` `EmpiricalFeature` + `H_e`; writes snapshot/Parquet. |
| Market | `analytical.py` + `market/alpaca.py` behind `market/base.py` `MarketData` | Gated to top-N by `H_e`. |
| Orchestrate | `cli.py` `cmd_run` | The 5-min loop tying it together. |
| Store | `db.py` | DuckDB DDL + idempotent upserts. |
| Output | `dashboard.py` | Streamlit; pure loader funcs are import-testable without Streamlit. |
| Config | `config.py` | `config.toml` (tunables) + `.env` (secrets). |

## Two pluggable interfaces (the extension seams)

- **`Source`** (`sources/base.py`) — one abstraction over Reddit taps. `ArcticShiftSource` is the only
  live impl; PullPush is frozen, Discord/Reddit-API are deferred. New taps slot in here without
  touching callers.
- **`MarketData`** (`market/base.py`) — the "funnel" over market providers. `AlpacaMarketData` (free)
  is the only impl; Massive (paid, full-market) and IBKR are intended alternatives behind the same
  interface. Per-ticker data is gated to the WSB-hot list; the free **screeners** are the one
  market-wide read (captured now for STEALTH in v0.0.2).

## Concurrency & output model (critical — touches multiple files)

- **The `run` daemon is the SINGLE DuckDB writer.** DuckDB takes an exclusive lock. The **dashboard
  never opens DuckDB** — it reads `data/leaderboard.json` (current board) and `data/history.parquet`
  (time views), both written atomically (temp-file + rename) by the radar. This is why Docker runs a
  `radar` writer + a read-only `dashboard` reader off one shared volume. **Don't add a second DB
  writer or make the dashboard query DuckDB directly.**
- The JSON snapshot is the dashboard's contract; `aggregate.write_snapshot` defines its shape.
- `run` is a plain **synchronous** `time.sleep` loop (not asyncio, despite architecture §3's mention),
  with per-cycle `except Exception` self-heal and SIGTERM→graceful-shutdown.

## Invariants you must not break (architecture §5; enforced in code)

- **Rank on `sov`, never raw counts or cold-start `z`.** `z` is computed but kept out of the `H_e`
  blend until its hour-of-week baseline is `ready` (config weight `heat.weights.z = 0.00` until then).
  Baselines are **forward-only** — no backfill.
- **Components are max-normalized within the window, not percentile-ranked** — see `aggregate._max_norm`'s
  docstring for *why* (percentile rank would let secondaries override the SoV-primary signal).
- **Ranking is deterministic** — equal-scored rows break ties by an explicit total order
  (`h_e → sov → authors → mentions → ticker`) in `aggregate.aggregate_window`, and `mentions_in_window` /
  `sov_ranks_at` are `ORDER BY`-stable; the board never depends on DB row or dict-insertion order.
- **`velocity`/`accel` are `None` when there is no real prior window** (cold start or a polling gap).
  Emitting 0-based deltas would make every ticker look like a fresh breakout and inflate `H_e`. The
  `run` loop re-aggregates W−1 (persist-only) before the current window so prior-window momentum is final.
- **A partial poll (`PollResult.ok == False`) is discarded whole** — not persisted, aggregated, or
  marked — because an undercounted window biases the SoV denominator. (`arctic_shift._fetch` →
  `cmd_run`.)
- **A `capped` poll (pagination cap hit) is persisted but flagged low-trust** — unlike `ok == False`
  (discarded), a capped window keeps its data but is surfaced (`snapshot["capped"]` → dashboard banner)
  as undercounted/untrustworthy `sov` (data-model invariant 14). Don't treat capped as complete.
- **Missing whitelist fails CLOSED to cashtag-only**, never to bare-token extraction (which would
  flood the board with uppercase non-tickers). See `cli._build_extractor`.
- **`rvol` / `ret` are day-to-date, NOT window-aligned** — `H_m` answers "hot *today*", not "hot *this
  hour*". `rvol` is tagged low-confidence (`rvol_conf="low"`) on the thin free IEX feed. Don't over-read
  fine-grained divergence until intraday bars land.
- **Outcome/P&L stays per-post — never aggregate to a per-ticker win rate** (survivorship bias).
- **Arctic-Shift is the sole live tap** (no free fallback). `heartbeat` alarms on staleness; the
  runbook is: radar stops, re-test before resuming. Don't publish stale signals.

## Config & secrets

- `config.toml` — committed tunables (cadence, regex, `H_e`/`H_m` weights, thresholds).
- `.env` — secrets (`ALPACA_*`), **gitignored**. `config.py` overlays `os.environ` `ALPACA_*` so
  containers/k8s can inject creds without a file. `whitelist/symbols.txt` is **derived** (gitignored);
  `whitelist/stoplist.txt` and `ambiguous.txt` are curated and committed.
