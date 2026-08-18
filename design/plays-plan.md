# WSB Plays — build plan

**Status: IN BUILD — P0 landed 2026-08-18; P1 code landed 2026-08-18 (gate pending: live capture run
+ gallery-prevalence / Reddit-JSON success-rate measurement); P2 next after the gate.** The product
spec and decisions record
live in [`plays-product.md`](./plays-product.md); this doc is the *how*: architecture deltas, repo
repositioning, schema, the LLM seam, config, and the slice order. Conventions follow
`v2-plan.md` — each slice lands green (`typecheck` + tests) with its gate met before the next starts.

## 1. Architecture deltas

Everything lands inside the existing topology — no new services:

```
┌ worker (@wsb/worker) ────────────────────────────────────────────────┐
│  radar loop (5 min, UNCHANGED): poll → extract → classify → H_e/H_m │
│      └─ NEW: flair-matched raw posts → plays capture (enqueue only)  │
│  NEW plays queue (own tick, error-isolated, budget-capped):          │
│      media archive → LLM extract → validate → LLM interpret →        │
│      categorize → denormalize → publish                              │
│  NEW marks job (daily, after US close): mark open plays → Alpaca     │
└──────────────────────────────────────────────────────────────────────┘
        │ Postgres (new plays* tables, same DB, same writer role)
        ▼
┌ web (@wsb/web, read-only role) ──────────────────────────────────────┐
│  /plays, /plays/:id (NEW)   /board (existing heat board)             │
│  /api/plays*, /api/media/** (serves the shared media volume)         │
└──────────────────────────────────────────────────────────────────────┘
```

- **One process, three loops — structurally isolated, not just `try/catch`'d.** The plays queue and
  marks job live in the worker process beside the radar loop (same advisory lock), each a
  recursive-timeout loop (**never `setInterval`** — the `loop.ts` house rule; ticks must not
  overlap). Isolation is enforced by construction (invariant P1 via P9), because three concrete
  failure paths would otherwise cross the wall:
  - **Dedicated PG pool for the plays loops.** The radar pool is pg-default `max: 10` with no
    connect timeout, and the advisory lock permanently holds one client (`db.ts`) — a plays
    transaction held open across a 10–60 s LLM call could starve `publishCycle` silently. Hence
    also invariant P9: no transaction or pooled client is ever held across a network/LLM call.
  - **Shared shutdown — two phases, because abort-everything contradicts P8.** Aborting an
    in-flight LLM fetch bills partial tokens *and* re-runs the stage on restart (double charge).
    Phase 1 (drain): stop claiming new work, abort the radar's poll fetches (cheap to redo), and
    let in-flight LLM calls **complete and commit** their child-row transaction. Phase 2 (abort):
    after the drain deadline, abort whatever remains. The worker awaits both phases, then closes
    the pools (today's `startWorker` `finally` would end the pool under in-flight plays queries).
    Compose gets a `stop_grace_period` sized to phase 1 + slack, not Docker's 10 s default.
  - **Memory & CPU.** A total-bytes cap plus downscaling on images per LLM request — 8 × 10 MB
    images is ~107 MB of base64 in the same heap as the radar; an OOM kills both loops, not one.
    Downscaling is **`sharp`** (libvips — native, and the workspace already pre-approves native
    builds): pure-JS resizing or base64 of full-size images is seconds of *synchronous* CPU on the
    one event loop the radar shares — P1 can be violated by CPU, not just memory. `sharp` does its
    work on libvips threads, off the main loop.
  - **Exception paths.** `loop.ts` installs a global `uncaughtException → process.exit(1)` (and a
    guarded `unhandledRejection`) — one unguarded synchronous throw in plays code kills the radar.
    Rules: **`index.ts` owns all process-level handlers** (the loops never install their own — a
    second copy of today's handler block would race shutdown); every plays tick awaits every
    promise it starts (no floating promises), and each loop's tick body is the exception boundary.
    A repeatedly-throwing plays tick disables the plays loop with a loud log; the radar keeps
    running.
  - **Shared external quota.** Alpaca allows ~200 req/min account-wide; the marks job (per-contract
    snapshots) and the radar's market overlay draw from the same bucket. One shared rate limiter,
    and marks batches are bounded (≤ 100 contract symbols per snapshot call — the API cap — and
    paced) so a fat marks day can't starve the radar's H_m cycle.
  No new container. If P1 still proves leaky in practice, the escape hatch is running the plays
  loops as a second process on the same schema — the queue design (leases, statuses) already
  tolerates it.
- **Media volume.** `data/media/plays/<post_id>/<n>.<ext>` on a volume mounted by both worker
  (write) and web (read) — the same shared-volume idiom the v0.0.1 snapshot used. LAN-only, so the
  web serves files straight off it via a Nitro route.
- **Radar tables untouched.** Parity tables (`raw_posts` … `cycle_runs`) keep their exact shapes;
  plays data is self-contained in new tables. The capture stage reads the *raw* Arctic-Shift dicts
  in-flight (see §3) instead of widening `raw_posts`.

## 2. Slice P0 — repo repositioning (prune the oracle, reframe the docs)

The Python v0.0.1 tree did its job (cutover gate passed 2026-06-09) and now it's the main obstacle
to the repo reading as the product it's becoming. Everything removed here is recoverable at tag
`oracle-final` (the last pre-prune commit; tag `v0.0.1` has the frozen radar but predates the
`oracle/` harness and the shadow gate).

**Remove:** root `wsb_signals/` + `tests/` + `pyproject.toml`/`uv.lock`/`Dockerfile` + root
`docker-compose.yml` (it builds that Dockerfile — deleting one without the other leaves a broken
`docker compose up` at the root) + root `.env.example` + `docker/entrypoint.sh`; the Python deploy
artifacts `deploy/install.sh`, `deploy/wsb-signals*.service`, `deploy/README.md` (superseded by
`deploy/v2/README.md`); `oracle/` (fixture dump + replay scripts); `scripts/*.py` **except
`scripts/probe_alpaca.py`** (stdlib-only, survives the uv removal — P5's option-feed re-probe uses
it); the shadow gate (see blast radius below); and `design/nuxt-migration.md` (tombstone).

**Shadow-gate blast radius (checked against the code):** `db.ts:28` imports `Readback`/
`ReadbackDiff` from `./shadow`, and `loop.ts` calls `verifyPublished` every shadow cycle — deleting
`shadow*.ts` naively fails this slice's own typecheck gate. **Keep `verifyPublished` and the
`Readback` types by moving them into `db.ts`, wired unconditionally in the loop**: the post-publish
read-back catches write-path bugs (NULL `h_e`, JSONB round-trips, BIGINT coercion) that have
nothing to do with the oracle. Delete the rest: `shadow.ts` (dump + `wordsets`),
`shadow-diff.ts`/`shadow-cli.ts`, the `shadow-diff` package script, `--shadow` in `index.ts`, the
`CycleDeps.shadow`/`onInputs` plumbing in `loop.ts`/`pipeline.ts`, the `wordsets` export in
`extract.ts`, the shadow tests in `loop.it.test.ts`, and the shadow-volume comment in
`deploy/v2/compose.yml`.

**Keep:** **`fixtures/` and the worker parity tests.** They are the regression net pinning the
scoring math — Docker-free, cheap, and still meaningful after the oracle is gone. If scoring ever
changes intentionally, regenerate fixtures from tag **`oracle-final`** (the last pre-prune commit —
tag `v0.0.1` predates the `oracle/` harness, so the dump script only exists there): `git worktree
add /tmp/wsb-oracle oracle-final` + the old `oracle/dump_fixtures.py` procedure — documented in
`fixtures/README.md`.

**Reframe:** `CLAUDE.md` + `README.md` rewritten around *plays product + radar subsystem*;
`ROADMAP.md` gains the Plays phase; `design/` gains these two docs as the active direction;
`design/v2-porting-spec.md` §12 (the shadow gate) gets a tombstone note, and the
`deploy/v2/compose.yml` healthcheck comment pointing at the deleted `deploy/README.md` is fixed —
this repo's own rule is that doc/code drift is a bug. Accepted cost, stated: `verifyPublished`
running unconditionally adds ~4 window reads per 5-min cycle, negligible against a same-box
Postgres.

Gate: `pnpm -r typecheck` + all worker/web tests green with the tree pruned; docs describe the repo
that actually exists.

## 3. Slice P1 — capture & media

- **Ingest:** `PollResult` gains `rawPosts: RawThing[]` — the *full* raw dicts (~110 keys,
  verified live) for the polled posts, with `RawThing` exported. **The `Source` seam stays
  plays-agnostic**: flair filtering happens in `plays/capture.ts`, not inside `poll()` — coupling
  the Reddit tap to `plays.flairs` would leak product config into the one abstraction built to
  not know about it (trivial memory cost at ~35 posts/cycle). `normalizePost` and all parity
  behavior stay byte-identical. **Capture keys on the posts-side fetch succeeding** (`p.ok`), not
  the whole poll: architecture §5's discard-partial-polls invariant protects the *SoV denominator*
  — plays capture aggregates nothing, and a prolonged comments-side failure would otherwise lose
  a whole window of plays whose media is meanwhile being deleted. The radar's own discard
  semantics are untouched. **The enqueue is a best-effort insert *outside* every radar
  transaction, after `publishCycle` commits** — inside it, a plays-table error would roll back the
  radar cycle (P1). Re-delivery (~12 sightings/post) makes idempotency load-bearing
  (invariant P8): the `plays` insert is **`ON CONFLICT DO NOTHING`**, and no writer ever moves
  `status` backwards. Explicitly NOT the radar's `onConflictDoUpdate` house style — that would
  reset status and re-enqueue (and re-charge) every play 12×/hour.
- **Media resolver** (`plays/media.ts`), per the media shapes (product §3): direct `i.redd.it`
  download; gallery → fetch `https://www.reddit.com<permalink>.json` (browser-ish UA, the post is
  minutes old) — **image order comes from `gallery_data.items[].media_id`**, with `media_metadata`
  supplying extensions: `media_metadata` alone is an *unordered* keyed object, and the first
  gallery image is nearly always the position screenshot, so the ≤ 8-image LLM cap must take the
  first eight, not an arbitrary subset. (The Reddit fetch is required because Arctic-Shift archives
  gallery `media_metadata` as `null` — verified 2026-08-18.) Also resolve **inline images in
  self-posts** (`media_metadata` present on a text post) rather than dropping to text-only. Caps:
  ≤ 20 images stored / ≤ 8 to the LLM / ≤ 10 MB each, plus the per-request total-bytes cap (§1).
  Archive with sha256 + bytes recorded. **Transient fetch failures retry with bounded backoff**
  (mirroring `ingest.ts`) and a `media_retry_until` window of a few minutes — a single 429 at
  capture minute must not permanently convert a screenshot play into a text-only one; capture is
  the one reliable moment the media exists (invariant P7). Only after retries: degrade to
  text-only with lowered confidence.
- **Schema (in `@wsb/shared`, one migration):**

  | Table | Shape (abridged) |
  |---|---|
  | `plays` | `id` (reddit post id, PK); all timestamps **bigint epoch seconds** (the schema-wide `int8` convention — no `timestamptz` drift): `created_utc`, `captured_at`, `published_at`; `author`, `flair`, `title`, `selftext`, `permalink`, `url`, `is_gallery`, `media` jsonb (paths+hashes), `media_status`, `raw` jsonb (full Arctic-Shift dict — provenance + reprocessing); `score`, `num_comments`, `removed`, `refreshed_at` (the ≥ 48 h refresh marker, P5 — without it "once per play" is unenforceable and the pass re-selects the same rows forever; archive-time engagement values are 0/1); **queue fields:** `status`, `attempts`, `next_attempt_at`, `claimed_at` (lease), `error`; **current-run pointers:** `current_extraction_at`, `current_interpretation_at`; denormalized board fields filled by P3: `primary_ticker`, `category`, `tags` jsonb, `confidence`, `pnl_abs`, `pnl_pct`, `realized`, `summary`, `tldr`, `extractor_version`, `interpreter_version`, `taxonomy_version`; tracking: `track_status`, `track_until`. Indexes: `status`, `published_at`, `primary_ticker`, `category`, `(track_status, track_until)`, `(author, primary_ticker)`. |
  | `play_extractions` | surrogate `id` PK; unique `(play_id, run_at)` with `run_at` in **milliseconds** (a fast retry in the same second must not be an insert error); `model`, `prompt_version`, `output` jsonb, `tokens_in/out`, `cost_usd` |
  | `play_interpretations` | same keying; `model`, `prompt_version`, `evidence` jsonb (the assembled radar+market block — invariant P2), `output` jsonb, `tokens_in/out`, `cost_usd` |
  | `play_marks` | **`(play_id, position_id, ts)` PK** (`ts` = session date) — per *position*, not per play: a portfolio play holding shares and options cannot carry one `source`/`feed_conf`, and partial closes would be invisible at play grain. `mark_value`, `pnl_abs`, `pnl_pct`, `source` (`close\|option_mark\|intrinsic_floor\|expiry_intrinsic`), `feed_conf`, `note`. Play-level P&L = sum over positions. |
  | `play_links` | `(play_id, resolution_play_id)` PK, `kind` (`author-followup`), `linked_at` |

- **Queue skeleton:** recursive-timeout tick (default 60 s — never `setInterval`: with
  `max_plays_per_tick` vision calls a tick can easily outlast the interval, and overlapping ticks
  double-process the same rows, i.e. double-spend). Rows are claimed with
  `FOR UPDATE SKIP LOCKED` under a lease: `claimed_at` is set on claim, and a row whose
  `claimed_at < now − lease_minutes` is **re-claimable** — without stale-lease recovery, a crash
  mid-LLM-call strands its rows as claimed-forever. `attempts`/`next_attempt_at` drive backoff;
  `failed` is terminal **only after `max_attempts`** — a single transient OpenAI 429 must not
  permanently kill a play, and a play that crashes the tick must not burn budget on every pass.
  **Each stage commits its child row + status advance + cost in one transaction** (the LLM call
  itself stays outside any tx, per P9) — that makes crash-between-call-and-commit the *only*
  double-charge path, bounded by `max_attempts` (P8). Statuses: `captured → media_ready →
  extracted → analyzed → published`, off-ramp `failed` (with `error`). Media state lives in
  `media_status`, not the queue status — a media failure degrades to text-only and the queue
  proceeds. LLM stages stubbed in P1.
- Web: a bare `/plays` list of captured rows (title, flair, thumbnail) — proves the volume + media
  route end-to-end before any LLM money is spent. This means the **minimal `/api/media/**` route
  and the shared media volume land here in P1**, not P4 (the gate needs thumbnails; P4 only grows
  the UI around them). The P1 gate also **measures gallery prevalence and Reddit-JSON fetch
  success rate** — if galleries are common and the fetch 403s, most plays degrade to text-only
  and the product is mostly hidden-by-default rows; better to learn that before P2 spends money.

Gate: live worker captures real plays with images on disk; testcontainers IT covers capture +
media states; radar cycle timing unaffected.

## 4. Slice P2 — LLM seam & extraction

**Adapter decision: Vercel AI SDK** (`ai` + `@ai-sdk/openai`), wrapped in our own seam.

- Rationale: provider-agnostic by construction (OpenAI now; `@ai-sdk/anthropic`/Google/local
  OpenAI-compatible `baseURL` later are config-only swaps), first-class zod structured outputs
  (`generateObject` — zod 4 already a worker dep), image inputs, maintained. Hand-rolling an
  OpenAI-compatible client was rejected: it re-implements structured-output parsing/retry and ties
  us to "OpenAI-compatible" — the thing the provider-agnostic requirement exists to avoid.
- **Seam:** `plays/analyzer.ts` exports a `PlayAnalyzer` interface (`extract(images, text)`,
  `interpret(evidence)`); the AI-SDK implementation is one file; tests inject a fake. Pipeline code
  never imports `ai` directly — the same pattern as `Source`/`MarketData`.
- **Extraction:** zod `PlayExtraction` schema + prompt v1 (constants under `plays/prompts/`,
  versioned). The schema is **pinned against P5's marking math** (per-leg positions, `side`, full
  expiry, multiplier convention — product §4.1) so outcome tracking never forces a paid re-run of
  the backlog. Two AI-SDK constraints to verify at install: `generateObject` zod-4 support needs
  `ai` v5+, and OpenAI strict structured outputs reject `.optional()` — the schema uses
  `.nullable()` throughout `[verify at P2]`. Deterministic validation pass per product §4.1
  (three-outcome ticker check incl. known-non-equity underlyings, P&L arithmetic cross-check at
  2 % tolerance, confidence derivation — invariant P3). **The P2↔P5 pin is compile-checked, not
  aspirational: P2 lands a pure `markPlay(extraction, quotes)` function signature + unit tests
  over the pinned schema** (sign conventions, multiplier, per-leg summing); P5 fills in the quote
  plumbing. Nothing else forces the pin to hold across three slices.
- **Metering — fail-closed (invariant P6):** token/cost accounting per call → `cost_usd`.
  **Per-model prices live in config** (`[plays.llm.prices]`), and a **zero or missing price for a
  configured model refuses dispatch** (queue the play, log loudly) — "price as the most expensive
  known entry" is empty when the only entries are the shipped `0.0` placeholders, and a $0 meter
  makes the daily cap literally inert (all four external reviewers flagged this independently).
  The daily counter is **summed from today's `cost_usd` rows in the DB** — an in-memory counter
  re-opens the cap on every restart. Pre-dispatch enforcement reserves the worst case (input
  tokens + configured `max_output_tokens`); actual cost reconciles after the call. The P2 gate's
  "budget caps proven by unit test" must include the all-zero-price and restart cases —
  otherwise it proves the cap against a $0 meter.
- **Eval harness:** `plays-eval` runs the extractor over `fixtures/plays/` — **≥ 30 real captured
  screenshots** (a dozen gives ±20-point confidence intervals: 80 % would be indistinguishable
  from 60 %), stratified across screenshot kinds (single position / portfolio / order ticket) and
  brokers/dark-mode, redacted of usernames **and account identifiers** — and machine-scores a
  field-by-field diff against hand-labeled expected JSON (exact match per field; a correct `null`
  scores as correct; per-field accuracy reported, not one blended number). Machine scoring makes
  the harness repeatable across model swaps, which is what it exists for — model choice is decided
  here. A manual quality *gate*, not CI; CI covers the seam with the injected fake. **Marking-
  critical fields get their own near-perfect thresholds** (ticker, side, quantity, strike, expiry
  — the fields P5's money math consumes): an aggregate 80 % can pass while every expiry is wrong.
  Deploy ordering fixes that surfaced here: `OPENAI_API_KEY` in `deploy/v2/.env.example` and the
  §1 `stop_grace_period` land **at P2** (live paid calls start here, not P4), and basic
  **spend + queue-depth logging also lands at P2** — money starts moving three slices before P6's
  ops polish.

Gate: eval set ≥ 80 % field accuracy (hand-judged); budget caps proven by unit test; live queue
extracts real plays.

## 5. Slice P3 — interpretation, categorization, publish

- **Evidence builders (deterministic TS, no LLM):** `plays/evidence.ts` — radar block (heat rank +
  SoV from the **last complete window**: max `cycle_runs.window_start` strictly below the post's
  hour bucket, because the post's own bucket is still accumulating and is rewritten every 5-min
  cycle — reading it would base the board's headline evidence chip on ~minutes of data; trailing
  24 h/72 h mentions + distinct authors; prior same-ticker+direction position-post count
  **excluding the play's own mention** = herd measure) and market
  block (Alpaca day/5-day return, rvol + its confidence flag, movers membership). Stored verbatim
  in `play_interpretations.evidence`.
- **Interpret call:** prompt v1 with the model-recalled-facts labeling rule (product §4.2);
  taxonomy v1 with the herd-threshold guard — the category enum presented to the model *excludes*
  `herd-following` unless the evidence block clears `plays.herd_min_authors` (invariant P4 enforced
  structurally, not by instruction).
- Denormalize results onto `plays` and set `published_at` **plus the
  `current_extraction_at`/`current_interpretation_at` pointers in the same row update** — publish
  is that update (readers filter `status = 'published'`). Detail pages read child rows **by the
  pointers, never `max(run_at)`**: a reprocess that writes a new interpretation and dies before the
  row update must not leave v2 evidence displayed under a v1 category badge.
- **Board P&L semantics, decided:** the card and `|P&L|` sort use the **posted** P&L (what the
  screenshot showed — that *is* the play's content); open tracked plays additionally show a
  current-mark delta badge from the latest `play_marks` row. Marks never overwrite the denormalized
  posted P&L.

Gate: ~20 live plays reviewed by hand read sensibly; `herd-following` appears only with evidence;
versions + evidence stored on every row.

## 6. Slice P4 — web board

`/plays` index + `/plays/:id` detail + `/api/plays*` + `/api/media/**` per product §4.5; heat board
moves under `/board` with nav + cross-links. Confidence badges; default filter hides
low-confidence/`unclassifiable`. Outcome chart placeholder. Marks chart is a dependency-free inline
SVG sparkline (no chart lib). The `/api/media/**` route normalizes and prefix-checks the resolved
path before serving (the id comes from the URL; LAN-only lowers the traversal concern, it doesn't
remove it). Compose: media volume mounted read-only into web; `OPENAI_API_KEY` added to
`deploy/v2/.env.example` (worker only); worker `stop_grace_period` raised per §1.

Gate: browse real plays end-to-end on the LAN deploy; web lint/typecheck/IT green.

## 7. Slice P5 — outcomes

- **Marks job** — trading days only, gated on Alpaca `/v2/calendar` and run ≥ 30 min after the
  session close (a fixed UTC tick drifts with DST and writes duplicate holiday marks into the
  `(play_id, ts)` PK): eligible = published plays with `realized: false` positions. Shares →
  Alpaca daily close (free tier = IEX, ~2.5 % of volume — marks carry `feed_conf` the way
  `rvol_conf` does). Options → OCC symbol built from the per-leg extraction (side / strike / full
  expiry / ×100 multiplier — pinned in the P2 schema for exactly this) → free **indicative**
  snapshot; spreads mark as the sum of their legs. When a far-OTM contract has no quote — the
  likely common case at WSB strikes; the Phase 0.2 probe (`probe_alpaca.py`, 2026-06-03) verified
  Greeks/IV **"on liquid strikes"** only — record intrinsic as **`intrinsic_floor`, which the UI
  never draws as a price point pre-expiry** (a live 30-DTE OTM call is not worth −100 %; the
  sparkline shows a gap, not a crash). At expiry finalize as `expiry_intrinsic`, status `expired`.
  Horizon: `track_until` (default 60 d, extended to option expiry). P5 re-probes the contract feed
  cheaply (entitlements change).
- **Author-followup linker** — runs when a play finishes interpretation, not at capture: at
  capture `primary_ticker` doesn't exist yet (it's filled by P3), so a capture-time join is on
  NULL. Look back for an open play by the same author + primary ticker (90 d) → `play_links` +
  `resolved-posted`. Null/`[deleted]`/bot authors (config bot list) never join — deleted-author
  plays would otherwise cross-link freely. **Ambiguity resolves to nothing:** one author can hold
  several open plays on the same ticker; link only on a unique match (refined by option
  identity/expiry where extracted), otherwise leave unresolved — a wrong resolution is worse than
  none. When P5 lands it runs **one idempotent backlog reconciliation** over plays published
  during P3/P4, which the linker's arrival otherwise misses.
- **Scheduler durability:** the marks job is **calendar-driven, recomputed each wake** — fetch the
  next session's close from `/v2/calendar` (which also handles half-days) and sleep until close
  + 30 min; never a fixed 24 h or fixed-UTC-hour sleep. A `job_runs` ledger rows each session;
  a missed session (worker down) leaves a **gap** — option quotes are not reconstructible after
  the fact, so catch-up never fabricates marks. Note: `/v2/calendar` lives on the **Trading host**
  (`api.alpaca.markets`) and per-contract option snapshots are a Data-host endpoint the radar
  never calls — **P5 grows the `MarketData` seam** (calendar + option snapshots); the current
  `market.ts` surface is snapshots/screeners only, and the plan must not pretend otherwise.
- **≥ 48 h refresh pass** — its own daily tick, **not** gated on trading days (a weekend post's
  `removed` flag must not wait for Monday's close; sets `refreshed_at`, once per play): re-query
  Arctic-Shift for
  live `score`/`num_comments` → the `plays` columns. Not earlier: the archive ingests at creation
  and its engagement numbers stay 0/1 until ~36 h (`arctic-shift-api.md` — "do not trust
  engagement numbers on <36h-old items"); a 24 h one-shot would freeze zeros forever. The same
  pass sets `removed` when Reddit shows the post removed/deleted — an auto-published board
  otherwise accumulates 404 permalinks with locally served screenshots and no flag; the UI gets a
  removed-post treatment. **A 404 from both probes IS the removed signal** — treat it as
  `removed`, not as a failed refresh that retries forever.
- UI: outcome sparkline + status on the detail page; "resolved by" cross-link.

Gate: a real YOLO play accrues marks across closes; expiry intrinsic finalization unit-tested;
option-feed probe outcome recorded in this doc.

## 8. Slice P6 — agent analysis tooling & polish

- `design/plays-analysis.md`: schema map, canonical SQL, and the **mandatory bias caveats**
  (invariant P5) an analyzing agent must repeat in its output.
- `plays-export` CLI (`pnpm -C packages/worker plays-export -- --from … --to … --format json|csv`)
  → `data/exports/`.
- **Reprocess path — a separate queue mode that NEVER touches `status`** (three reviewers
  independently flagged the contradiction with P8's "status never moves backwards"): rows whose
  `extractor_version`/`interpreter_version`/`taxonomy_version` trails current are picked by a
  reprocess flag while staying `published` — the board keeps serving the old child rows via the
  current-run pointers until the new rows commit and the pointers advance (the P3 publish rule
  makes this crash-safe; a play never blanks from the board mid-reprocess). Idempotency is per
  **(play, stage, version)**. Budget-aware by design: a full-corpus re-run competes with the daily
  cap (weeks of cap at scale), so it requires an explicit budget override flag.
- `deploy/v2/README.md` + ops runbook additions (budget knob, queue-depth logging, media-volume
  sizing **~500 MB/month** — 200 KB–2 MB per screenshot at ~45 plays/day — plus a retention/
  pruning knob so the named volume isn't unbounded).

## 9. Config additions (`config.toml`)

```toml
[plays]
enabled = true
flairs = ["Gain", "Loss", "YOLO", "Verified Trade"]
queue_interval_s = 60
max_attempts = 4               # transient-failure retries before a play is terminally `failed`
lease_minutes = 10             # stale-claim recovery: claimed_at older than this is re-claimable
media_retry_minutes = 10       # re-attempt window for transient media-fetch failures
max_images_stored = 20
max_images_llm = 8
max_image_mb = 10
max_request_mb = 24            # total image bytes per LLM request (memory + provider limits)

[plays.llm]
provider = "openai"            # AI-SDK provider id; "anthropic", … later — config-only swap
extract_model = "gpt-5-mini"   # placeholder — pick at P2 against the eval set
interpret_model = "gpt-5-mini"
max_plays_per_tick = 5
max_output_tokens = 2000         # per call — also the worst-case pre-dispatch cost reservation
daily_budget_usd = 5.0           # UTC day; counter is summed from cost_usd rows in the DB

[plays.llm.prices."gpt-5-mini"]  # $/Mtok per configured model — the metering source of truth
input = 0.0                      # (invariant P6). FAIL-CLOSED: a zero or missing price for a
output = 0.0                     # configured model REFUSES dispatch (loud log) — these shipped
                                 # placeholders deliberately keep the queue parked until P2 sets
                                 # real prices; they never mean "free".

[plays.herd]
lookback_hours = 72
min_authors = 5                # herd-following unlockable only at/above this (invariant P4)

[plays.outcomes]
horizon_days = 60
resolution_lookback_days = 90
```

Secrets: `OPENAI_API_KEY` (worker env; later `ANTHROPIC_API_KEY` etc.). Web gains no new secrets.

## 10. New dependencies

`@wsb/worker`: `ai`, `@ai-sdk/openai`, **`sharp`** (image downscale/re-encode off the main event
loop — pure JS cannot resize a JPEG, and shipping full-size images instead would blow both the
token budget and the §1 memory cap; the workspace already pre-approves native builds). Media
*fetching* uses undici (present), charts are inline SVG, web adds nothing.

## 11. Risks & open questions

- **Reddit JSON fetch for galleries** may 403 on some networks — home-LAN residential IP + sane UA
  is expected to pass; P1 verifies live. Fallback is text-only analysis (invariant P7), so failure
  degrades rather than blocks. `[verify at P1]`
- **Alpaca free per-contract option marks** — verified on this account (Phase 0.2 probe,
  2026-06-03); re-probe at P5, intrinsic-value fallback is the floor either way.
- **Extraction quality on cluttered screenshots** (portfolio views, dark-mode crops) — the eval set
  + confidence machinery is the mitigation; model choice is decided by the P2 eval, not upfront.
- **Flair renames** on the sub silently zero the capture volume — the worker logs a per-day capture
  count; a zero-capture day with nonzero poll volume warrants a flair-list check.
- **Earnings/macro enrichment is thin by design** (free sources only): model-recalled events are
  labeled unverified; a free earnings-calendar source can be a later, separate proposal.
- **Single-process isolation has accepted residual risk** (OOM, disk-full, an exception path the
  §1 rules miss): named in invariant P1, with the second-process escape hatch pre-designed (the
  lease-based queue already tolerates it).
- **Movers-list evidence:** `sources/alpaca.md` marks the screeners "[uncertain free]", but the
  Phase 0.2 probe verified them working on this account's free tier — the evidence chip is real;
  re-confirm during P3 (entitlements change).
