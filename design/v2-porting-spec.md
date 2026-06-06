# v2 Porting Spec — the Python→TypeScript parity contract

> **Status:** authoritative for the v2 full-TS worker rewrite. **Frozen reference = `git tag v0.0.1`**
> (the Python radar). This document freezes every behavior the TS port must reproduce *exactly*, so
> "parity" is well-defined and each port slice has a pass/fail gate. Written after a multi-model review
> of the B decision; the landmines in [§8](#8-cross-language-landmines-the-checklist) are the ones that
> review (and the code) flagged as most likely to drift silently.
>
> **Rule:** if the TS behavior would differ from what's written here, that's a bug in the port — change
> the port, not this spec. If this spec is ever found to mismatch the v0.0.1 code, that's a spec bug —
> fix the spec to match the frozen oracle (the oracle is ground truth).

## 0. How to use this

- Each port **slice** ([build order in the v2 plan]) must pass its parity gate against the v0.0.1
  oracle before the next slice starts.
- The numeric core is **deterministic by construction** in v0.0.1 (the determinism stabilization:
  canonical tie-breakers + `ORDER BY`-stable reads + `sort_keys` JSON). So parity here means **exact
  value + exact ordering**, not "within epsilon and roughly the same order."
- Float math is **bit-exact** between a faithful port and the oracle (same IEEE-754 ops in the same
  order — incl. `(x-mean)*(x-mean)` not `**2`), so ordering is reproduced exactly on **raw** floats. Do
  **NOT** quantize before compare (§2.6 — the original quantize guidance was wrong; the randomized
  fixtures disproved it). Never accept "Spearman ≈ 1" as a pass for the scoring slice — a single rank
  inversion is a real bug.

## 1. Parity comparison boundary & the oracle harness

The oracle (frozen Python) writes **DuckDB**, the port writes **Postgres** — so do **not** diff at the
DB-row level. Diff at these language-neutral boundaries, in order of slice:

| Boundary | Artifact to diff | Produced by |
|---|---|---|
| B1 — raw fetch | Arctic-Shift / Alpaca **response JSON** (recorded fixtures) | VCR cassettes (§4, §5) |
| B2 — normalized | `RawPost` / `RawComment` / `StockSnapshot` / `Mover` objects | `models.from_arctic`, client parsers |
| B3 — mentions | the `list[Mention]` for a thing/text (sorted by `thing_id, ticker`) | `cli._mentions_from_poll` |
| B4 — features | the `list[EmpiricalFeature]` / `AnalyticalFeature` for a window | `aggregate.aggregate_window`, `analytical.compute_analytical` |
| B5 — snapshot | the **`leaderboard.json`** payload | `aggregate.write_snapshot` |

**Oracle harness (build first, before any TS):** a small Python CLI on the `v0.0.1` tag that, given a
recorded input fixture, dumps B2–B5 as canonical JSON (sorted keys, fixed float precision). The TS test
suite loads these golden files and asserts deep equality. `leaderboard.json` (B5) is already emitted by
the radar — it's the natural top-level oracle; B2–B4 need thin dump hooks. **Do not** port `db.py` to
Postgres-in-Python to compare at the DB level (that's wasted double-work — the boundary is the object/
JSON, not the row).

## 2. Numeric / scoring invariants (`aggregate.py`) — the crown jewels

Reproduce `aggregate_window` exactly. Reference: `wsb_signals/aggregate.py` @ `v0.0.1`.

### 2.1 Window math
- `window_start_for(now, w) = Math.floor(now / w) * w`. Use **`Math.floor`**, never `| 0` / `~~`
  (those truncate toward zero — wrong for any negative, a latent landmine). Epochs are integer seconds.
- `hour_of_week(epoch)`: Python `gmtime().tm_wday` is **Monday=0…Sunday=6**; JS `getUTCDay()` is
  **Sunday=0**. Port: `how = ((getUTCDay(epoch*1000) + 6) % 7) * 24 + getUTCHours(epoch*1000)`. **This
  remap is mandatory** — getting it wrong silently misbuckets every baseline.

### 2.2 Per-ticker aggregation
- Group mentions by ticker; **dedup things by `thing_id`** (one mention per `(ticker, thing)` — the
  §2.1 grain). Iterate mentions in `thing_id` order (the DB read is `ORDER BY thing_id`).
- `authors` = count of distinct non-empty author names.
- `bull`/`bear` = count of mentions whose `direction` is `"bull"`/`"bear"`.
- `dd` = set of `thing_id` where `thing_type == "post"` and `flair.strip().upper() == "DD"`.
- `flairs` = Counter of non-empty flair strings.
- `total` = Σ distinct things across all tickers, **or 1** if zero (avoid div-by-zero).
- `sov = m / total` where `m` = this ticker's distinct things.

### 2.3 Momentum (null semantics are load-bearing)
- `prior = features_at(ws - w)` (mentions+velocity of W−1 by ticker); `prior_exists = len(prior) > 0`.
- If **not** `prior_exists`: `velocity = accel = null` (NOT 0 — a gap/cold-start must not read as a
  breakout). 
- If `prior_exists`: `velocity = m - (prior[ticker].mentions ?? 0)`; `pv = prior[ticker].velocity`;
  `accel = (pv != null) ? velocity - pv : null`.

### 2.4 Direction & baseline z
- `net_dir = (bull - bear) / (bull + bear)` if `(bull+bear) > 0` else `0`.
- baseline samples = prior windows' `mentions` in the **same `hour_of_week` bucket** (`feature_history(ws)`
  filtered). Let `n = len(samples)`.
- If `n >= max(2, min_samples_ready)`: `status = "ready"`; `mean = Σx/n`; `var = Σ(x-mean)² / (n-1)`
  (**sample variance, n−1 denominator, two-pass**: compute mean first, then the squared-deviation sum);
  `sd = sqrt(var)`; `z = (m-mean)/sd` if `sd > 0` else `null`.
- elif `n > 0`: `status = "warming"`, `z = null`. else `status = "cold"`, `z = null`.
- The `max(2, …)` guard is mandatory (n−1 with n=1 divides by zero).
- **`sd` landmine (≤1-ULP, NOT exactly reproducible):** the oracle computes `sd = var ** 0.5` — CPython's
  `**` on a float routes to libm **`pow`**, which is **1 ULP off correctly-rounded `sqrt` in ~0.08% of
  inputs** (measured). The TS port uses `Math.sqrt` (correctly rounded — and V8's `Math.sqrt` == Python
  `math.sqrt`). Do **NOT** "fix" this with `Math.pow(var, 0.5)`: that re-introduces the cross-engine `pow`
  instability §2.6 deliberately bans (and is no closer to the oracle). So `z` (and, where the `z` weight is
  non-zero, a sub-ULP nudge to `h_e`) can differ by ≤1 ULP from the oracle. The parity tests already
  tolerate this (`toBeCloseTo(_, 9)`); the live-shadow diff surfaces it as **NEAR** (§12) — the canonical
  case the §2.6 sub-ε tolerance exists for. It is **not** a port bug.

### 2.5 rank_delta, normalization, blend
- `cur_rank`: rank tickers by `sorted(key = (-sov, ticker))`, 1-based. `rank_delta = prior_rank −
  cur_rank` if the ticker had a prior rank (`sov_ranks_at(ws-w)`, ordered `sov DESC, ticker ASC`), else `0`.
- `_max_norm(values)`: `vmax = max(values, default 0)`; if `vmax <= 0` → all `0.0`; else each
  `max(0, v) / vmax` (**negatives floored to 0**).
- Max-norm these component arrays (None→0 where noted): `sov`, `accel` (None/neg→0), `rank_delta`,
  `authors`, `dd_count`, `z` (None→0).
- `h_e = w.sov·sovₙ + w.accel·accₙ + w.rank_delta·rdₙ + w.authors·auₙ + w.conviction·ddₙ +
  w.net_dir·|net_dir| + (ready ? w.z·zₙ : 0)` where `ready = (status=="ready" && z != null)`.
  Note `net_dir` uses **`|net_dir|`** (conviction strength), and is **not** max-normed.
- **Support shrink:** if `min_authors_full > 0`: `h_e *= min(1, authors / min_authors_full)`.

### 2.6 Canonical ordering (frozen in v0.0.1 — reproduce exactly)
- Final board: sort by `(-h_e, -sov, -authors, -mentions, ticker)` (total order; deterministic).
- `flair_counts` is a canonical **sorted-key** object (a JSONB object in v2; parity is on the counts).
- **Sort on RAW floats — do NOT quantize.** The port is bit-exact to the oracle (same IEEE-754 ops in the
  same order; use `(x-mean)*(x-mean)`, not `**2`/`pow`, for the variance), so equal rows compare equal and
  genuinely-different rows compare exactly as Python's raw sort does — *including* when the oracle's order
  rests on a **1-ULP `h_e` difference** (e.g. `0.4` vs `0.39999999999999997`). Quantizing `h_e`/`sov` to
  1e-9 (this section's ORIGINAL guidance) DISCARDS that real signal and inverts such pairs vs the oracle —
  the `fixtures/aggregate/random/010` scenario proved it empirically. If the live shadow (§9) ever shows a
  1-ULP order flip, put the tolerance in the **shadow-diff comparison** (treat sub-ε `h_e` rows as
  tie-equivalent), never in the production sort.

### 2.7 Bounded z-baseline read (v2 DELIBERATE DIVERGENCE — slice 10 / M5)
The oracle's `db.feature_history(before)` reads **all** prior `empirical_features` and lets `aggregate_window`
filter to the `hour_of_week` bucket in memory. On a long-running v2 worker that read grows without bound and
pulls ~168× the rows it uses each cycle. The v2 read (`db.readFeatureHistory`) therefore differs from the
oracle in two ways:
- **Scoped (parity-preserving):** the `hour_of_week` filter is pushed into SQL, so the read returns exactly
  the subset the scorer keeps. The SQL expression mirrors `aggregate.hourOfWeek` op-for-op — Postgres
  `extract(dow …)` is Sun=0..Sat=6, identical to JS `getUTCDay()`, so `(((dow+6)%7)*24 + hour)`. The scorer's
  in-memory bucket filter stays as a redundant safety net, and `reads.it.test` pins the SQL and JS to agree.
  Because the golden fixtures feed `aggregate_window` directly (bypassing the read), they are **unaffected**.
- **Bounded (the only behavioral change):** the read is limited to the trailing `[ws − baseline.lookback_seconds, ws)`
  window (default **26 weeks**; must exceed `min_samples_ready` weeks or buckets never reach `ready`). The
  baseline becomes a **rolling ~6-month** window instead of all-time. With `heat.weights.z = 0` this has
  **zero** effect on `h_e` — it changes only the persisted `z` field, and only once a deploy accumulates
  >lookback of history. **The shadow gate stays green:** the worker captures the (already-bounded)
  `feature_history` it read, and `oracle/replay.py` replays *that* captured input, so both sides score the
  same population — no DRIFT. (The trade-off: the live shadow no longer re-checks the oracle's in-memory
  bucket filter across multiple buckets, since the capture is pre-scoped; the fixtures cover that path.)

**Consequences when `z` is eventually weighted (currently `z=0`, so none today):**
- The rolling window makes `baseline_status` **non-monotonic**: a (ticker, hour-of-week) that was `ready`
  can fall back to `warming` once its active weeks age past the lookback, and a sparse pair with <
  `min_samples_ready` mentions in any trailing window stays `warming` forever (the oracle's all-time read
  would eventually promote it). This is the intended "recent regime" behavior, not a bug — but it means z
  participation flickers for low-volume tickers. Before flipping `heat.weights.z` non-zero, run a shadow
  pass with `baseline.lookback_seconds` set very large to confirm z-parity on a real window first (a manual
  step — the gate cannot detect input-population divergence, see above).
- **Why bound now rather than defer** (the reviewers' main objection — bound only when z is enabled):
  bound-now was a deliberate call. The bound is also what makes the read **indexable** — the hour-of-week
  filter is a computed expression a plain B-tree can't serve, so without the `window_start >= from` range
  the query degrades to a growing seq-scan; with it, the existing `empirical_features_window_start_idx`
  range-scans only the trailing window. So the bound earns its keep on performance even while `z=0`.

## 3. Extraction & classification

### 3.1 Extractor (`extract.py`) — decision precedence (exact)
Regex `(?<![A-Za-z0-9])(\$)?([A-Z]{1,5})(?![A-Za-z0-9])` (fixed-length lookbehind — JS-safe). Per match
`(cash, sym)`, in this order:
1. `cash` present → `cashtag` (bypasses stop/whitelist/ambiguous).
2. `len(sym) < 2` → `too_short` (bare single letter dropped).
3. `sym in stoplist` → `stop`.
4. `whitelist != null && sym not in whitelist` → `not_listed`.
5. `sym in ambiguous` → if `has_trading_context(text)` then (`whitelist_ok` if whitelist else `open_ok`)
   else `ambig_no_context`. (Context computed **once per text**, lazily.)
6. else → `whitelist_ok` if whitelist else `open_ok`.

`ACCEPT = {cashtag, whitelist_ok, open_ok}`. `extract()` returns accepted `sym`s. **`whitelist`
distinction:** `null` = no whitelist (accept any non-stop) vs **empty set** = fail-closed cashtag-only
(every bare token → `not_listed`). Preserve both.

- `has_trading_context(text)`: `true` if `"$" in text` **or** any token from `text.toLowerCase().match(/[a-z]+/g)`
  is in `TRADING_WORDS` (frozen set — copy verbatim from `extract.py`).
- `_load_wordset(path)`: per line, take substring before first `#`, trim, split on whitespace, union
  into a set. Port byte-for-byte (comment stripping + whitespace split + empty-line skip).

### 3.2 Classifier (`classify.py`)
`direction(text)`: tokens = `text.toLowerCase().match(/[a-z']+/g)`; `bull` = count in `BULL`, `bear` =
count in `BEAR` (frozen sets — copy verbatim). `bull>bear → "bull"`, `bear>bull → "bear"`, else
`"neutral"`. v0.0.1 attaches one direction per **thing**, applied to every ticker in it.

### 3.3 Mention assembly (`cli._mentions_from_poll`)
- Skip authors in the `bots` set **before** extracting.
- Post text = `f"{title} {selftext}"`; comment text = `body`.
- Per thing: `direction` once; `set(extract(text))` (dedup symbols within a thing); one `Mention` per symbol.

## 4. Ingestion I/O contract (`sources/arctic_shift.py`)

Reproduce `_fetch` + `poll` exactly:
- Initial cursor `before = now + 5` (**deliberate +5s skew buffer** — catches items created between
  `now` capture and the request; undocumented elsewhere, easy to miss).
- Per page: GET `/{kind}/search?subreddit=&limit=page_limit&sort=desc&after=cutoff&before=before`.
- After a 200: honor rate limit — read `X-RateLimit-Remaining`; if present & `< 50`, sleep **2s**
  (guard non-numeric/absent header → ignore).
- Parse `json.data` (default `[]`). If empty → stop. Append items. `oldest = min(created_utc, default now)`.
  Stop if `oldest <= cutoff` **or** `len(data) < page_limit`. Else `before = oldest`, sleep **0.3s**, next page.
- Ran all `max_pages` without stopping → `capped = true`.
- `in_window = items where created_utc >= cutoff`.
- **`ok` semantics:** any of {request exception, non-200 status, non-JSON body} mid-walk → `ok = false`,
  break, return partial. The caller **discards** an `ok=false` poll whole.
- `poll`: fetch **posts then comments** separately; `capped = pcap || ccap`; `ok = pok && cok`;
  `newest_utc = max(all created_utc)` or null.
- **HTTP client choice (landmine):** `httpx` does **not** throw on 4xx/5xx (the code checks
  `status != 200`). Use **`undici`/`fetch` with a manual `res.ok`/status check** — do **NOT** use a
  client that throws on non-2xx (e.g. `ofetch` default), which would invert the `ok` logic.

## 5. Market I/O contract (`market/alpaca.py`)

- Auth headers: `APCA-API-KEY-ID`, `APCA-API-SECRET-KEY`. Base `https://data.alpaca.markets`. `feed=iex`.
- `snapshots(tickers)`: chunk by **100** symbols (URL-length); GET `/v2/stocks/snapshots?symbols=…&feed=`;
  non-200 → warn & **continue** (best-effort, partial OK). Map: `price=latestTrade.p`,
  `day_open/close/volume=dailyBar.{o,c,v}`, `prev_close/volume=prevDailyBar.{c,v}`, `as_of=now`.
- `screeners(top)`: GET `/v1beta1/screener/stocks/most-actives?top=` → `kind="active"`, rank by order,
  `volume`. GET `/v1beta1/screener/stocks/movers?top=` → gainers (`kind="gainer"`) + losers
  (`kind="loser"`), rank by order, `price`,`percent_change`. Best-effort per call.
- `compute_analytical` (`analytical.py`): `ret = (price-prev_close)/prev_close` if both present else null;
  `rvol = day_volume/prev_volume` if both present else null; `rvol_conf = "low"`; `h_m = w.ret·|ret|ₙ +
  w.rvol·rvolₙ` (max-norm over the hot list, None→0). Market overlay is **best-effort: a failure must
  never kill the cycle.**

## 6. Persistence & schema (Postgres + Drizzle)

- Schema ports from `db.py SCHEMA` (architecture §2.7). **Epoch columns stay `BIGINT`** — no
  `timestamptz` (keeps the integer floor-division math identical). Reddit `id`s are **strings** (`TEXT`);
  never let a driver coerce them to JS `number`. Postgres `BIGINT` returns as a **string** in most
  drivers — coerce epochs explicitly with care.
- **`flair_counts` → `JSONB`** (canonical, sorted-key object).
- **Per-table `ON CONFLICT` (reproduce exactly):**
  - `raw_posts(id)`: **DO UPDATE** `score, num_comments, retrieved_on`. `raw_comments(id)`: **DO UPDATE**
    `score, retrieved_on` (comments have no `num_comments`).
  - `mentions(ticker, thing_id)`: **DO NOTHING** (keep first-seen — never update `created_utc`, which
    would move the mention to a different window).
  - `empirical_features(ticker, window_start)` / `analytical_features(…)` / `market_movers(ts,kind,rank)`
    / `ticker_names(symbol)`: **DO UPDATE** the non-key columns.
- **Batch upserts must chunk at ≤ 1000 rows** — a single multi-row `INSERT` is capped at Postgres's
  **65535 bind parameters** (7-col `mentions` × ~9k/cycle ≈ 63k; a peak DDT window busts it). Python's
  `executemany` round-trips avoid this; Drizzle's `.values([...])` does not.
- **Atomic publication (MANDATORY, not optional):** wrap each cycle's writes (empirical + analytical +
  movers) in **one transaction**, and/or write a `run_status`/`cycle_runs` publish marker. The web must
  read only **publish-complete** cycles — never a window where empirical rows exist but analytical rows
  are still in-flight (that renders market columns blank for in-scope tickers, indistinguishable from
  "not top-N"). Reads select the latest **complete** `window_start`. The `cycle_runs` marker also carries
  **`newest_utc`** so a reader can banner DATA staleness (`now − newest_utc`) distinctly from WORKER
  liveness (`now − generated_at`) — the never-serve-stale requirement (§7).
- **Overlay replacement vs. preservation (v2):** publishing a window's analytical set is **delete-then-
  insert** so a shrunk top-N can't leave stale rows. But an **empty** overlay must **preserve** the prior
  (it means every snapshot chunk failed — `snapshots()` swallows non-200s — not "no hot tickers"); only a
  **non-empty** overlay replaces. The oracle's `upsert_analytical_features([])` is a no-op (never deletes),
  so this keeps v2 from wiping good prices on a total market outage.
- **W−1 finalize is transactional (v2):** the persist-only re-aggregation of W−1 wraps its (chunked)
  `empirical_features` upsert in **one transaction** — a crash mid-chunk must not half-write the prior
  baseline. (This does not defeat self-heal: a rolled-back W−1 is simply re-aggregated next cycle.)

## 7. Worker loop & lifecycle (`cli.cmd_run`)

- **Standalone Node process** (its own container), **not** a Nitro task. Loop = `while (!stopping) {
  … await sleep(Math.max(5000, interval - elapsed)) }` (recursive-timeout style; **never `setInterval`**
  — no overlap).
- SIGTERM → set `stopping` flag → finish/abort the in-flight cycle at a safe point → close clients →
  exit (mirror the Python SIGTERM→graceful-shutdown).
- **Per-cycle `try/catch`** isolates faults (self-heal, retry next interval). Also install
  `process.on('unhandledRejection')` and `uncaughtException` guards — an unhandled rejection otherwise
  kills the daemon (Python's cycle-level `except` has no Node equivalent by default).
- **Double-run guards:** a **Postgres advisory lock** (and/or PID file) so two instances can't both poll.
  A session advisory lock lives on its **connection** — hold it on a dedicated checked-out client, enable
  `keepAlive`, and **probe it every cycle** (a trivial query; if it throws, the connection — and the lock
  — is gone: a failover / `idle_session_timeout` can drop it silently). On loss, **exit non-zero** so the
  orchestrator restarts a clean singleton.
- **Mark-poll ordering (v2 divergence):** persist `.last_poll` **AFTER** the (transactional) ingest upsert
  commits, not before (the oracle marks first). A crash between poll and persist then leaves no marker → a
  restart retries promptly instead of throttling on a window it never stored. `.last_poll` is a lifecycle
  marker, not a scoring input, so this departs from the oracle without affecting parity.
- **Shutdown aborts the in-flight poll:** thread the stop `AbortSignal` into the poll's `fetch` so SIGTERM
  cuts a long network wait short (before any writes), rather than blocking shutdown for the request timeout.
- **`uncaughtException` exits** (non-zero) for a clean restart — only `unhandledRejection` is log-and-continue.
- Startup throttle: persist `.last_poll`; on boot, if `elapsed < min_poll_gap_seconds`, wait the
  remainder (ignore a future-dated/corrupt marker).
- **Cycle order (preserve exactly):** poll → if `!ok` skip whole cycle → mark poll → extract+upsert →
  **re-aggregate W−1 (persist-only)** → aggregate W (snapshot, `capped` flag) → market overlay
  (best-effort) → freshness log. The W−1 re-aggregation's writes **must be committed before** the W
  aggregation reads them (pooled connections can otherwise read stale W−1).
- **Freshness / never-serve-stale:** persist the cycle's freshness state; the web banners stale/dead-
  worker rather than letting route caching serve a polished-but-dead board.

## 8. Cross-language landmines (the checklist)

Gate the relevant slice on each:
- [ ] `Math.floor` for epoch window math (not `|0`/`~~`).
- [ ] `hour_of_week` weekday remap (Python Mon=0 vs JS Sun=0).
- [ ] Two-pass sample variance, `n−1` denominator, `max(2, …)` guard, `sd>0 else null`.
- [ ] `velocity`/`accel` **null** (not 0) when no prior window.
- [ ] `_max_norm`: `vmax<=0 → zeros`; negatives floored to 0; `default 0` on empty.
- [ ] z enters the blend only when `ready && z!=null`; `net_dir` uses `|net_dir|`, un-normed.
- [ ] Canonical sort `(-h_e,-sov,-authors,-mentions,ticker)` on **RAW** floats — bit-exact port, NO quantize (§2.6).
- [ ] `flair_counts` canonical sorted-key JSON.
- [ ] Extractor precedence incl. `whitelist null vs empty` (cashtag-only fail-closed); `_load_wordset` format.
- [ ] HTTP client does **not** throw on 4xx/5xx; `capped` vs `ok` have **opposite** persistence.
- [ ] Arctic-Shift `before=now+5`, 0.3s inter-page, 2s rate-limit backoff, stop conditions, `for-else→capped`.
- [ ] Per-table `ON CONFLICT`; `mentions` is `DO NOTHING`; never update `created_utc`.
- [ ] Batch upserts chunked ≤1000 rows (65535-param limit).
- [ ] Atomic per-cycle publish + complete-window reads.
- [ ] SIGTERM graceful; `unhandledRejection`/`uncaughtException` guards; advisory-lock double-run guard.

## 9. Test strategy (per the review)

- **Property-based parity** (`fast-check` in TS): generate random mention sets (varying ticker counts,
  author overlaps, direction mixes, flairs) → feed both pipelines → assert **deep equality** on the
  `EmpiricalFeature` list (values **and** order). Mirror the seeds in a Python `hypothesis` run on the oracle.
- **Adversarial fixtures:** all-zero window; single-mention (support shrink floor); ≥5 tied-SoV tickers
  (canonical tie-break); DD-only; ambiguous-only / no-context; cold vs gap vs prior-present; baseline
  warming↔ready; epoch-boundary seconds; capped vs partial polls.
- **I/O fault injection** (mock Arctic-Shift/Alpaca server, not just VCR happy-path): 500 on page 3,
  non-JSON on page 5, missing/garbage rate-limit headers, empty page mid-walk, connection reset,
  partial post-vs-comment fetch → assert `ok`/`capped` semantics match the oracle exactly.
- **Live shadow** before cutover — see **§12** for the implemented design. (The original "run both live
  into **separate tables** and diff" framing was **superseded**: two *independent* live polls fetch
  different data, so their boards can never match exactly — an un-gateable, noisy comparison. The live TS
  worker instead **captures the exact inputs its scorer consumed** and replays them through the frozen
  oracle, so the diff is a **deterministic** value+order check on real data. The TS worker running live by
  itself is what exercises real rate-limit curves / data shapes — no second live poller is needed.)
- **Observability for debugging drift:** the worker's `--shadow` dump carries per-cycle B3 (poll+mentions)
  and B4 (the aggregate inputs + the board) in identical field names, so the diff pinpoints which
  ticker/component diverged (§12).

## 10. Also-port surface (don't forget)

Beyond the loop: `build-whitelist`/`assets.py` (writes `whitelist/symbols.txt` the extractor reads —
match the file format), `heartbeat` (exit codes 0/1/2), structured logging with matching field names,
TOML/config loading (the `config.toml` tunables in §2–§5 above), and the `pretty_name` company-name
formatting (`db.pretty_name`).

**Status (slice 10 / M5):**
- ✅ **`build-whitelist`** — `worker/src/assets.ts` (`fetchAlpacaAssets`/`buildWhitelist`) + the
  `build-whitelist` CLI entry. Fetches Alpaca `/v2/assets` (via `ALPACA_ENDPOINT_URL`, default the paper
  host — distinct from the data host), writes `symbols.txt`, upserts `ticker_names`.
- ✅ **`heartbeat`** — `worker/src/heartbeat.ts` (pure `heartbeatVerdict` + `ArcticShiftSource.newestItemLag`),
  exit `0`/`1`/`2`. It is the worker container's Docker healthcheck.
- ✅ **Config root resolution** — `config.findRoot()` walks up to `config.toml` (or honors `WSB_ROOT`), so the
  worker finds its config + wordlists regardless of cwd. The documented `pnpm -C packages/worker …`
  commands and the container both run with cwd=`packages/worker`, which holds no `config.toml`; the prior
  `process.cwd()` assumption would have thrown ENOENT on the first real run.
- ⏳ **`pretty_name`** — deferred with the web (slice 8); display-only, not on the headless data path.
- ⤬ **Diagnostic/ops CLIs intentionally NOT ported** (decision 2026-06-06): `eval-extractor`, `poll-once`,
  and the one-shot `aggregate`/`market` wrappers. All are off the data path and either redundant with
  `start --once [--no-market]` (aggregate/market) or low-value next to the `heartbeat` probe + per-cycle
  logs (poll-once); `eval-extractor` (extractor precision proxy) is the only one with distinct value and can
  be ported later if extractor tuning needs it. `init-db` is superseded by migrate-on-boot;
  `aggregate.write_snapshot` is the v0.0.1 JSON/Parquet workaround, replaced by the Postgres atomic publish.

**→ The headless Python→TS migration is functionally COMPLETE** (data path fully ported + parity-gated;
248 tests). The only remaining work is the Nuxt web (slice 8), deferred by plan — a Streamlit→SSR reframe,
not a port.

## 11. Signals — Attention × Action (slice 7) — NEW, **no oracle**

This slice has **no parity gate**: the frozen v0.0.1 radar creates the `signals` table but never populates
it (divergence / quadrants / lead-lag are explicitly Phase 3 / v0.0.2 — see `dashboard.py`, `cli.py`). So
unlike §2–§5, there is nothing to diff against; the math is gated by its own unit + integration tests
(`packages/worker/test/analytics.test.ts`, `signals.it.test.ts`). This section is therefore the
**authoritative spec** for the chosen semantics (signal-framework §6), not a record of oracle behavior.
Code: `analytics.ts` (pure), `pipeline.buildSignals` (orchestration), `db.ts` reads + `upsertSignals`.

- **Grain & population.** One `signals` row per **board ticker** per window (mirrors `empirical_features`),
  in the atomic publish. `H_m`/divergence/quadrant/lead-lag are populated **only for the overlaid subset**
  (the top-N hot tickers that have an `analytical_features` row) — you can't compare attention to action
  with no action measurement; the rest carry `H_e` + `rank` only. **Effective `H_m`** at W = this cycle's
  fresh overlay, or — when the market fetch failed and the cycle PRESERVES the prior overlay (§6) — the
  committed `analytical_features` at W (read back), so signals always reflect the H_m the window carries.
- **`divergence = H_e − H_m`** (signed; null when no H_m). +ve = chatter ahead of market (HYPE side);
  −ve = market ahead of chatter (STEALTH side).
- **Quadrant = GLOBAL rolling median split**, with **per-axis populations** (the M3-review correction).
  Recomputed each cycle: the **`H_e` threshold** = median over the trailing `median_lookback_seconds` of
  the **FULL board's** cells **+ this window's board** — so "WSB quiet" means *genuinely low attention*
  and a top-N-hot ticker is never mislabelled STEALTH; the **`H_m` threshold** = median over the trailing
  **overlaid** cells (only they have market data) **+ this window's overlaid cells** (W isn't committed
  yet, so the current cells are added in-memory). **"Hot" = STRICTLY above** the threshold. CONFIRMED =
  hot/hot, HYPE = hot/quiet, STEALTH = quiet/hot, QUIET = quiet/quiet. Rolling (not cross-sectional-per-
  window, not per-ticker — matches the literal "rolling median" and avoids a per-ticker cold-start). A
  quadrant is assigned only once the limiting (**overlaid**) population ≥ `min_quadrant_population` (else
  null) so a 1–2-cell cold start can't produce a degenerate / flip-flopping split.
  > **Earlier draft (superseded):** both thresholds over the *overlaid* population. The M3 review (gemini/
  > codex/qwen/deepseek) showed that splitting H_e over the top-N-gated set mislabels genuinely-hot tickers
  > as STEALTH (median of "the hottest" ⇒ half the hottest are "quiet"). Fixed to the full-board H_e
  > population above. On-board STEALTH is now correctly *rare* — true STEALTH needs the deferred screener path.
- **`rank` / `rank_delta`.** `rank` = 1-based position in the canonical **H_e** board order
  (`compareBoard` — the same total order `aggregateWindow` sorts on, reused via `db.readHeRanksAt` so the
  persisted ranks can't drift from the live board). `rank_delta = priorRank − curRank` (+ve = climbing);
  **null** when the ticker had no prior-window rank (NOT 0 — same "don't fake a delta" stance as
  velocity/accel, §2.3). This is the **H_e** leaderboard rank, distinct from the SoV `rank_delta` that
  feeds H_e inside `aggregate.py`.
- **Lead-lag (`lead_lag_hrs`) — DISABLED by default (`lead_lag.enabled = false`).** Per overlaid ticker,
  correlate its `H_e(t)` and `H_m(t)` series over the trailing `lead_lag.lookback_seconds` on a **regular
  window grid** (gaps = absent indices). For each integer lag k ∈ [−`max_lag_windows`, +`max_lag_windows`],
  Pearson-correlate `H_e[t]` with `H_m[t+k]`; the lag with the **highest** correlation is the lead-lag,
  **k>0 ⇒ WSB attention LEADS market action** → `k·window_seconds/3600` hours. **Null** unless some lag has
  ≥ `min_pairs` overlapping pairs AND peak correlation ≥ a **sample-size-scaled bar** `max(min_corr,
  2/√pairs)` (≈ p<0.05 — small early samples need a much higher r, partly offsetting the multi-lag search).
  - **Why off by default (M3 review, UNANIMOUS HIGH):** `H_m` is **day-to-date, not window-aligned**
    (`ret`/`rvol` share the day's denominator — §5, architecture §5). So intraday `H_m(t)` is a near-daily
    accumulation ramp, and an *hourly* cross-correlation against it measures that ramp, not a genuine
    lead-lag — a category error tuning can't fix. Both series are also **within-window max-normalized**
    (non-stationary), and `H_m` exists only where the ticker was top-N-gated (**selection on the very
    signal being correlated**). The code + guards are kept (and tested) so the path is ready, but it
    **persists null** until `H_m` is window-aligned (intraday bars land). Enabling it on day-to-date `H_m`
    would publish a misleading "WSB leads by Xh" — exactly what "badge, don't predict" (§6.2) forbids.
- **Out of scope (deferred):** screener-movers ∖ WSB-hot **STEALTH discovery** (tickers with no H_e, so
  not (ticker, H_e, H_m) rows) — the inputs stay captured in `market_movers`; surfacing them is a later
  query/web concern.
- **Acknowledged (not changed):** `signals.h_m`/`divergence` are the **publish-time** H_m, written in the
  **same atomic transaction** as `analytical_features` so the two are consistent in any committed state
  (cycle-level staleness is surfaced via `cycle_runs.newest_utc`/`generated_at`, §6/§7, not per signals
  row). `signals` uses a **plain upsert** (no delete-then-insert) — sound for live operation because the
  board is monotonic within a window (mentions only accumulate); an admin re-run *after deleting* mentions
  could leave stale rows, same as `empirical_features` (clear the window manually for such corrections).
- **Persistence:** `signals_window_start_idx` on `window_start` (the web reads the latest-window board;
  the `(ticker, window_start)` PK can't serve that) — mirrors the empirical/analytical window indexes.
- **Config** (`config.toml [signals]`): `median_lookback_seconds`, `min_quadrant_population`;
  `[signals.lead_lag]` `enabled`, `lookback_seconds`, `max_lag_windows`, `min_pairs`, `min_corr`. Tunables,
  not on any parity path.

## 12. Live shadow — replay-vs-oracle (slice 9, M4) — the cutover gate

Continuous, **deterministic** value+order parity of the TS worker against the frozen oracle, on **real
live data**. The scorer/extraction half of the cutover gate (the full criterion — shadow + read-back +
green ITs — is at the end of this section).

- **Design (chosen; supersedes the v2-plan "separate tables / beside the radar" wording).** Two
  *independent* live pollers fetch different data each cycle, so their boards could never match exactly — a
  noisy, un-gateable comparison. Instead the **one** live TS worker (`--shadow`) captures, per cycle, the
  **exact inputs its scorer consumed** + the board it produced; `oracle/replay.py` feeds those *identical*
  inputs through the frozen `aggregate_window`; `shadow-diff` asserts parity at the **object boundary**
  (§1 — never DB rows). Same input ⇒ any divergence is a **real port bug**, not input noise. This is
  strictly **stronger than the committed golden fixtures** (§9): it runs the parity contract against
  whatever real ticker / flair / author / unicode shapes the live firehose actually produces. The TS
  worker running live **by itself** is what exercises real rate-limit curves / data shapes — no second
  live poller (and no DuckDB↔Postgres row diff, §1) is needed.
- **Three artifacts.**
  - `packages/worker/src/shadow.ts` — the CAPTURE side (lean; on the worker hot path). `--shadow` (or
    `SHADOW=1`; dir = `SHADOW_DIR` or `<dataDir>/shadow`) writes one `cycle-<window_start>.json` per cycle:
    **B3** = the raw `poll` + assembled `mentions` (sorted `thing_id, ticker`); **B4** = the exact
    `inputs` the scorer read (`mentions_in_window`, `prior_features`, `prior_sov_ranks`, `feature_history`,
    + window/weights/config) and the `features` board (canonical order). Wire form is canonical
    **snake_case** = Python `model_dump` field names. Captured ONLY when the window had mentions; a
    discarded (`!ok`) cycle emits nothing. `flair_counts` is an **object** on the wire (the oracle's JSON
    *string* is parsed to one in replay) — parity is on the counts (§2.6). The dump also carries (M4
    review): a **`readback`** (the write-path check, below) and a **`wordsets`** fingerprint — per set,
    `{n, fnv}` where `fnv` is an FNV-1a (32-bit, `Math.imul`) over the C-sorted symbols, reproduced
    byte-identically in `replay.py`, so a stale `symbols.txt` is *detected* not silently misdiagnosed.
  - `oracle/replay.py` — drives the FROZEN oracle over the captured inputs via a **duck-typed fake-db**
    (returns the dumped `inputs` from the four reads `aggregate_window` calls — no DuckDB, no
    reconstruction) and re-runs `_mentions_from_poll` over the raw `poll`. Emits the oracle's B3+B4 truth
    in the same wire shape, plus **`wordset_match`** (its own wordset fingerprint vs the dump's). Verified
    to reproduce the committed `fixtures/aggregate/*` **bit-for-bit**.
  - `shadow-diff` (`pnpm -C packages/worker shadow-diff <tsDir> <oracleDir>`) — pairs cycles by
    `window_start`, runs the pure `diffCycle`, prints a per-ticker/per-component report, and exits
    **1 on any DRIFT** (a real parity failure), **2 on a SETUP error** (the gate couldn't certify: 0 paired
    cycles, or undiffed ts-only/oracle-only cycles from a stale/partial replay — `--allow-unpaired` to
    override — or a wordset mismatch), **0 only when parity holds**. (The old "exit 0 unless DRIFT" let a
    stale replay that produced 0 cycles pass green — codex/qwen M4 review.)
- **Diff semantics (`diffCycle`, `shadow-diff.ts`).** Verdict per cycle ∈ `MATCH | NEAR | DRIFT`, rolled
  up to the worst across cycles.
  - **Exact** (mismatch ⇒ DRIFT): integer/string fields (`mentions`, `authors`, `dd_count`,
    `baseline_status`, `ticker`, `window_start`), `flair_counts` (object/count compare), **null alignment**
    (`velocity`/`accel`/`z` null-vs-number is load-bearing — §2.3), membership (same ticker set), and the
    full **B3** mention stream (extraction/classification is pure ⇒ exact). `schema_version`/`window_start`
    mismatch is FATAL ⇒ DRIFT.
  - **Order** parity (the FULL comparator, M4-review hardened): both boards use the same total order
    (§2.6), so a positional disagreement is an inversion of an adjacent TS pair. Gap = `ts[i].h_e −
    ts[i+1].h_e ≥ 0`. Classification: **gap > ε ⇒ DRIFT**; **gap ≤ ε AND a cross-engine `h_e` WOBBLE
    explains it (`wobble ≥ gap > 0`, `wobble = |tsₐ−orₐ| + |ts_b−or_b|`) ⇒ NEAR** (a real 1-ULP tie flip);
    **gap ≤ ε but NO wobble (the pair's `h_e` is bit-identical on both engines) ⇒ DRIFT** — the order then
    rests purely on the secondary tie-break (`sov→authors→mentions→ticker`, all bit-identical across
    engines), so a reordering can ONLY be a secondary-comparator bug. (This closes the gap the earlier
    h_e-gap-only check masked, flagged by codex+gemini: a wrong tie-break among equal-`h_e` rows used to
    pass as NEAR.) The wobble test distinguishes a genuine sub-ε flip from a tie-break bug **without**
    consulting the secondary keys directly — so it never re-creates the `random/010` quantization bug §2.6
    bans. Completeness: a permutation of `[0..n)` with *no* adjacent inversion is the identity, so any order
    difference surfaces ≥1 adjacent inversion (and `compareBoard` is property-tested as a total order, so
    the adjacent scan can't be fooled by a non-transitive comparator).
  - **Sub-ε tolerance lives HERE and nowhere else** (§2.6): floats equal-or-within `ε = absEps(1e-12) +
    relEps(1e-12)·max|·|` are NEAR, not DRIFT. ε is sized to the ACTUAL cross-language wobble (~1e-15),
    leaving ~1000× headroom yet flagging any drift ≥ ~1e-11 as DRIFT. (Was `relEps=1e-9` — ~4.5M ULPs near
    1.0, loose enough to hide a real small-math bug; tightened per the M4 review.) **Known NEAR case:** `z`
    (and a non-zero-weight `h_e` nudge) differs by ≤1 ULP because the oracle uses `var ** 0.5` (libm `pow`)
    vs the port's `Math.sqrt` (§2.4) — ~0.08% of baseline-ready tickers. The gate must classify this NEAR.
  - **Write-path read-back ⇒ DRIFT** (M4 review — the unanimous strongest objection). The replay consumes
    the worker's *reads*, so it can't see a *write* bug. So in shadow mode, right after the atomic publish,
    `verifyPublished` re-reads the persisted `empirical_features` + `analytical_features` + `signals` + the
    `cycle_runs` marker for W and diffs them **bit-exactly** (same engine) against the in-memory board the
    gate just approved; the result rides in the dump's `readback`. `!readback.ok` (a wrong `ON CONFLICT`, a
    truncated column, a JSONB/BIGINT coercion, an `h_e` written NULL, a missing marker) ⇒ DRIFT. This is the
    seam the web actually reads, which replay-vs-oracle structurally cannot see.
  - **Wordset mismatch ⇒ SETUP, not DRIFT.** When `wordset_match === false`, B3 mention diffs are attributed
    to the stale wordlist (not a port bug): still reported, but excluded from the DRIFT rollup, and the CLI
    exits 2 (setup). B4 is wordset-independent, so it gates normally.
- **Operational.** **B4 (scoring) parity is wordset-independent** — it replays the captured mention rows
  directly, so it holds regardless of the whitelist. **B3 (mention) parity needs the SAME wordsets** the
  worker used: run `replay.py` against the **same repo state** (especially the derived, gitignored
  `whitelist/symbols.txt`). The `wordsets` fingerprint makes a mismatch explicit (a SETUP error pointing at
  `symbols.txt`) instead of a confusing B3 DRIFT. If `symbols.txt` is absent, both worker and replay
  **fail-closed identically** to cashtag-only (empty set) — still parity, reduced coverage. Runbook:
  `oracle/README.md`.
- **Cutover criterion (honest scope — M4 review).** The live shadow is **necessary but not sufficient**
  alone; cut over only when **all** hold over a sustained window: (1) **no DRIFT** in the shadow (H_e
  scoring + B3 extraction parity), (2) every cycle's **`readback.ok`** (the write path), AND (3) **green
  testcontainers ITs** in the cutover window (the SQL read shapes + `ON CONFLICT` + lifecycle). What the
  shadow does **not** cover, and what does: **SQL-read provenance** (a wrong `created_utc` window bound or
  `hour_of_week` filter would feed *both* sides the same wrong rows → MATCH) is gated by `reads.it.test.ts`
  + the transitive prior-read chain (each window's priors are a prior window's board, itself diffed) — not
  by replay alone; **H_m / market overlay** compute parity by the §5 fixtures (its write path by the
  read-back); **signals** (slice 7) by their own tests (§11, no oracle); **live-I/O robustness** (rate-
  limit/backoff/`ok`/`capped`/pagination) by the worker's own live loop + the §4/§5 fault-injection suites.
  Don't read a green shadow as certifying the layers above it.
