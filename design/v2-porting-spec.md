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
- Where exactness is genuinely impossible (float LSBs), the rule is: **quantize before compare** (§2.6)
  so ordering is still exact. Never accept "Spearman ≈ 1" as a pass for the scoring slice — a single
  rank inversion is a real bug.

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
- `flair_counts` stored as `JSON.stringify` with **sorted keys** (canonical string).
- For cross-language float safety, **quantize `h_e` and `sov` to a fixed precision (e.g. round to 1e-9)
  before the comparison key** in the TS port so LSB drift can't invert a near-tie. (The oracle is
  self-consistent without this; the port needs it to match the oracle's ordering under any float noise.)

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
  "not top-N"). Reads select the latest **complete** `window_start`.

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
- [ ] Canonical sort `(-h_e,-sov,-authors,-mentions,ticker)`; quantize h_e/sov before compare.
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
- **Live shadow** before cutover: run the TS worker alongside the frozen Python radar against the live
  APIs, write to **separate tables**, diff cycle-by-cycle (per-ticker, per-component) for a sustained
  window. Real rate-limit curves and Reddit/Alpaca data shapes only surface here.
- **Observability for debugging drift:** both pipelines dump per-cycle intermediate JSON (B2–B5) with
  identical field names so a diff pinpoints which ticker/component diverged.

## 10. Also-port surface (don't forget)

Beyond the loop: `build-whitelist`/`assets.py` (writes `whitelist/symbols.txt` the extractor reads —
match the file format), `heartbeat` (exit codes 0/1/2), structured logging with matching field names,
TOML/config loading (the `config.toml` tunables in §2–§5 above), and the `pretty_name` company-name
formatting (`db.pretty_name`).
