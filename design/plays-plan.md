# WSB Plays — build plan

**Status: DESIGN (approved direction, pre-implementation).** The product spec and decisions record
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
  - **Shared shutdown.** One AbortController spans all three loops; SIGTERM or advisory-lock loss
    aborts all of them, the worker awaits their drain, and only then closes the pools (today's
    `startWorker` `finally` would end the pool under in-flight plays queries). Compose gets a
    `stop_grace_period` long enough for an in-flight vision call to finish rather than being
    SIGKILLed at Docker's 10 s default — a killed call is paid work re-run on restart.
  - **Memory.** A total-bytes cap plus downscaling on images per LLM request — 8 × 10 MB images is
    ~107 MB of base64 in the same heap as the radar; an OOM kills both loops, not one.
  No new container.
- **Media volume.** `data/media/plays/<post_id>/<n>.<ext>` on a volume mounted by both worker
  (write) and web (read) — the same shared-volume idiom the v0.0.1 snapshot used. LAN-only, so the
  web serves files straight off it via a Nitro route.
- **Radar tables untouched.** Parity tables (`raw_posts` … `cycle_runs`) keep their exact shapes;
  plays data is self-contained in new tables. The capture stage reads the *raw* Arctic-Shift dicts
  in-flight (see §3) instead of widening `raw_posts`.

## 2. Slice P0 — repo repositioning (prune the oracle, reframe the docs)

The Python v0.0.1 tree did its job (cutover gate passed 2026-06-09) and now it's the main obstacle
to the repo reading as the product it's becoming. Everything removed here is recoverable at tag
`v0.0.1`.

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
changes intentionally, regenerate fixtures from the tag (`git worktree add /tmp/v001 v0.0.1` + the
old `oracle/dump_fixtures.py` procedure — document this in `fixtures/README`).

**Reframe:** `CLAUDE.md` + `README.md` rewritten around *plays product + radar subsystem*;
`ROADMAP.md` gains the Plays phase; `design/` gains these two docs as the active direction.

Gate: `pnpm -r typecheck` + all worker/web tests green with the tree pruned; docs describe the repo
that actually exists.

## 3. Slice P1 — capture & media

- **Ingest:** `PollResult` gains `playCandidates: RawThing[]` — the *full* raw dicts (~110 keys,
  verified live) for posts whose `link_flair_text` matches `plays.flairs` (`RawThing` gets
  exported). `normalizePost` and all parity behavior stay byte-identical. **Capture runs only for
  polls the radar accepts:** an `ok=false` poll is discarded whole (architecture §5) *including
  its candidates* — harmless, because the 5-min poll over a 1-h window re-delivers every post on
  ~12 consecutive cycles anyway. That same re-delivery makes idempotency load-bearing
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
  | `plays` | `id` (reddit post id, PK); all timestamps **bigint epoch seconds** (the schema-wide `int8` convention — no `timestamptz` drift): `created_utc`, `captured_at`, `published_at`; `author`, `flair`, `title`, `selftext`, `permalink`, `url`, `is_gallery`, `media` jsonb (paths+hashes), `media_status`, `raw` jsonb (full Arctic-Shift dict — provenance + reprocessing); `score`, `num_comments`, `removed` (filled by the ≥ 48 h refresh, P5 — archive-time engagement values are 0/1); **queue fields:** `status`, `attempts`, `next_attempt_at`, `claimed_at` (lease), `error`; **current-run pointers:** `current_extraction_at`, `current_interpretation_at`; denormalized board fields filled by P3: `primary_ticker`, `category`, `tags` jsonb, `confidence`, `pnl_abs`, `pnl_pct`, `realized`, `summary`, `tldr`, `extractor_version`, `interpreter_version`, `taxonomy_version`; tracking: `track_status`, `track_until`. Indexes: `status`, `published_at`, `primary_ticker`, `category`, `(track_status, track_until)`, `(author, primary_ticker)`. |
  | `play_extractions` | surrogate `id` PK; unique `(play_id, run_at)` with `run_at` in **milliseconds** (a fast retry in the same second must not be an insert error); `model`, `prompt_version`, `output` jsonb, `tokens_in/out`, `cost_usd` |
  | `play_interpretations` | same keying; `model`, `prompt_version`, `evidence` jsonb (the assembled radar+market block — invariant P2), `output` jsonb, `tokens_in/out`, `cost_usd` |
  | `play_marks` | `(play_id, ts)` PK (`ts` = session date), `mark_value`, `pnl_abs`, `pnl_pct`, `source` (`close\|option_mark\|intrinsic_floor\|expiry_intrinsic`), `feed_conf`, `note` |
  | `play_links` | `(play_id, resolution_play_id)` PK, `kind` (`author-followup`), `linked_at` |

- **Queue skeleton:** recursive-timeout tick (default 60 s — never `setInterval`: with
  `max_plays_per_tick` vision calls a tick can easily outlast the interval, and overlapping ticks
  double-process the same rows, i.e. double-spend). Rows are picked under a lease (`claimed_at`)
  with `attempts`/`next_attempt_at` backoff; `failed` is terminal **only after `max_attempts`** —
  a single transient OpenAI 429 must not permanently kill a play, and a play that crashes the tick
  must not burn budget on every pass. Statuses: `captured → media_ready → extracted → analyzed →
  published`, off-ramp `failed` (with `error`). Media state lives in `media_status`, not the queue
  status — a media failure degrades to text-only and the queue proceeds. LLM stages stubbed in P1.
- Web: a bare `/plays` list of captured rows (title, flair, thumbnail) — proves the volume + media
  route end-to-end before any LLM money is spent.

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
  2 % tolerance, confidence derivation — invariant P3).
- **Metering:** token/cost accounting per call → `cost_usd`; per-tick count cap + daily budget cap
  enforced *before* dispatch (invariant P6). **Per-model prices live in config next to the model
  ids** (`[plays.llm.prices]`) — hardcoded prices silently under-meter by 10–20× the moment the
  placeholder model is swapped for a frontier one, and the cap stops binding. A configured model
  with no price entry logs a warning and is priced as the most expensive known entry.
- **Eval harness:** `plays-eval` runs the extractor over `fixtures/plays/` — **≥ 30 real captured
  screenshots** (a dozen gives ±20-point confidence intervals: 80 % would be indistinguishable
  from 60 %), stratified across screenshot kinds (single position / portfolio / order ticket) and
  brokers/dark-mode, redacted of usernames **and account identifiers** — and machine-scores a
  field-by-field diff against hand-labeled expected JSON (exact match per field; a correct `null`
  scores as correct; per-field accuracy reported, not one blended number). Machine scoring makes
  the harness repeatable across model swaps, which is what it exists for — model choice is decided
  here. A manual quality *gate*, not CI; CI covers the seam with the injected fake.

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
  plays would otherwise cross-link freely.
- **≥ 48 h refresh pass** (piggybacks the marks job, once per play): re-query Arctic-Shift for
  live `score`/`num_comments` → the `plays` columns. Not earlier: the archive ingests at creation
  and its engagement numbers stay 0/1 until ~36 h (`arctic-shift-api.md` — "do not trust
  engagement numbers on <36h-old items"); a 24 h one-shot would freeze zeros forever. The same
  pass sets `removed` when Reddit shows the post removed/deleted — an auto-published board
  otherwise accumulates 404 permalinks with locally served screenshots and no flag; the UI gets a
  removed-post treatment.
- UI: outcome sparkline + status on the detail page; "resolved by" cross-link.

Gate: a real YOLO play accrues marks across closes; expiry intrinsic finalization unit-tested;
option-feed probe outcome recorded in this doc.

## 8. Slice P6 — agent analysis tooling & polish

- `design/plays-analysis.md`: schema map, canonical SQL, and the **mandatory bias caveats**
  (invariant P5) an analyzing agent must repeat in its output.
- `plays-export` CLI (`pnpm -C packages/worker plays-export -- --from … --to … --format json|csv`)
  → `data/exports/`.
- **Reprocess path:** select rows whose `extractor_version`/`interpreter_version`/
  `taxonomy_version` trails current → re-enqueue; new child rows land and the current-run pointers
  advance on completion (the P3 publish rule makes this crash-safe). Budget-aware by design: a
  full-corpus re-run competes with the daily cap (weeks of cap at scale), so it requires an
  explicit budget override flag.
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
daily_budget_usd = 5.0

[plays.llm.prices."gpt-5-mini"]  # $/Mtok per configured model — the metering source of truth
input = 0.0                      # (invariant P6). Set real values at P2; a configured model with
output = 0.0                     # no entry logs a warning and is priced as the most expensive one.

[plays.herd]
lookback_hours = 72
min_authors = 5                # herd-following unlockable only at/above this (invariant P4)

[plays.outcomes]
horizon_days = 60
resolution_lookback_days = 90
```

Secrets: `OPENAI_API_KEY` (worker env; later `ANTHROPIC_API_KEY` etc.). Web gains no new secrets.

## 10. New dependencies

`@wsb/worker`: `ai`, `@ai-sdk/openai`. That's the list — media archiving uses undici (present),
charts are inline SVG, web adds nothing.

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
