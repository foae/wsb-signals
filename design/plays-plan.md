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

- **One process, three loops.** The plays queue and marks job live in the worker process alongside
  the radar loop (same advisory lock, same SIGTERM handling), but on their own timers with their own
  `try/catch` walls — invariant P1. No new container.
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

**Remove:** root `wsb_signals/` + `tests/` + `pyproject.toml`/`uv.lock`/`Dockerfile` (the Python
oracle), `oracle/` (fixture dump + replay scripts), the shadow gate (`packages/worker/src/shadow*.ts`,
its tests, the `shadow-diff` script entry, `data/shadow*` conventions), the old Python `deploy/`
compose, and `design/nuxt-migration.md` (tombstone).

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
  verified live) for posts whose `link_flair_text` matches `plays.flairs`. `normalizePost` and all
  parity behavior stay byte-identical; candidates ride alongside.
- **Media resolver** (`plays/media.ts`), per the three verified shapes (product §3): direct
  `i.redd.it` download; gallery → fetch `https://www.reddit.com<permalink>.json` (browser-ish UA,
  the post is minutes old) to read `media_metadata` → `i.redd.it/<media_id>.<ext>` — **required
  because Arctic-Shift archives gallery `media_metadata` as `null`** (verified 2026-08-18); text-only
  otherwise. Caps: ≤ 20 images stored / ≤ 8 sent to the LLM / ≤ 10 MB each. Archive with sha256 +
  bytes recorded; any failure → `media_failed` (play proceeds text-only, invariant P7).
- **Schema (in `@wsb/shared`, one migration):**

  | Table | Shape (abridged) |
  |---|---|
  | `plays` | `id` (reddit post id, PK), `created_utc`, `captured_at`, `author`, `flair`, `title`, `selftext`, `permalink`, `url`, `is_gallery`, `media` jsonb (paths+hashes), `media_status`, `raw` jsonb (full Arctic-Shift dict — provenance + reprocessing), `status`, `error` — plus denormalized board fields filled by P3: `primary_ticker`, `category`, `tags` jsonb, `confidence`, `pnl_abs`, `pnl_pct`, `realized`, `summary`, `tldr`, `extractor_version`, `interpreter_version`, `taxonomy_version`, `published_at`. Indexes: `status`, `published_at`, `primary_ticker`, `category`. |
  | `play_extractions` | `(play_id, run_at)` PK, `model`, `prompt_version`, `output` jsonb, `tokens_in/out`, `cost_usd` |
  | `play_interpretations` | `(play_id, run_at)` PK, `model`, `prompt_version`, `evidence` jsonb (the assembled radar+market block — invariant P2), `output` jsonb, `tokens_in/out`, `cost_usd` |
  | `play_marks` | `(play_id, ts)` PK, `mark_value`, `pnl_abs`, `pnl_pct`, `source` (`close|option_mark|intrinsic`), `note`; plus `track_status`+`track_until` on `plays` |
  | `play_links` | `(play_id, resolution_play_id)` PK, `kind` (`author-followup`), `linked_at` |

- **Queue skeleton:** status machine tick (config interval, default 60 s) that picks pending rows;
  LLM stages stubbed. Statuses: `captured → media_ready|media_failed → extracted → analyzed →
  published`, off-ramps `failed` (with `error`), `skipped`.
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
  versioned); deterministic validation pass (whitelist ticker check, P&L arithmetic cross-check at
  2 % tolerance, confidence downgrade rules — invariant P3).
- **Metering:** token/cost accounting per call → `cost_usd` columns; per-cycle count cap + daily
  budget cap enforced *before* dispatch (invariant P6).
- **Eval harness:** `plays-eval` script runs the extractor over `fixtures/plays/` (a dozen real
  captured screenshots committed in P2, redacted of usernames) and prints a field-by-field diff
  against hand-labeled expectations. This is a *manual* quality gate, not CI — LLM output is not
  deterministic enough for golden tests; CI covers the seam with the fake.

Gate: eval set ≥ 80 % field accuracy (hand-judged); budget caps proven by unit test; live queue
extracts real plays.

## 5. Slice P3 — interpretation, categorization, publish

- **Evidence builders (deterministic TS, no LLM):** `plays/evidence.ts` — radar block (heat rank +
  SoV at the posting window from `signals`/`empirical_features`; trailing 24 h/72 h mentions +
  distinct authors; prior same-ticker+direction position-post count = herd measure) and market
  block (Alpaca day/5-day return, rvol + its confidence flag, movers membership). Stored verbatim
  in `play_interpretations.evidence`.
- **Interpret call:** prompt v1 with the model-recalled-facts labeling rule (product §4.2);
  taxonomy v1 with the herd-threshold guard — the category enum presented to the model *excludes*
  `herd-following` unless the evidence block clears `plays.herd_min_authors` (invariant P4 enforced
  structurally, not by instruction).
- Denormalize results onto `plays`, set `published_at` — publish is the row update (readers filter
  `status = 'published'`; no cross-table atomicity needed since children are written first).

Gate: ~20 live plays reviewed by hand read sensibly; `herd-following` appears only with evidence;
versions + evidence stored on every row.

## 6. Slice P4 — web board

`/plays` index + `/plays/:id` detail + `/api/plays*` + `/api/media/**` per product §4.5; heat board
moves under `/board` with nav + cross-links. Confidence badges; default filter hides
low-confidence/`unclassifiable`. Outcome chart placeholder. Marks chart is a dependency-free inline
SVG sparkline (no chart lib). Compose: media volume mounted read-only into web; `OPENAI_API_KEY`
added to `deploy/v2/.env.example` (worker only).

Gate: browse real plays end-to-end on the LAN deploy; web lint/typecheck/IT green.

## 7. Slice P5 — outcomes

- **Marks job** (daily post-close tick in the worker): eligible = published plays with
  `realized: false` positions. Shares → Alpaca daily close. Options → OCC contract symbol from
  extraction (ticker/expiry/strike/type) → free **indicative** options snapshot for the mark;
  fallback intrinsic-from-underlying; at expiry finalize as `expired`. Horizon: `track_until`
  (default 60 d, extended to option expiry). Per-contract option snapshots (Greeks/IV) were already
  **verified working on this account's free tier** (ROADMAP Phase 0.2, `probe_alpaca.py`,
  2026-06-03); P5 re-probes cheaply (entitlements can change) and intrinsic-only is the fallback.
- **Author-followup linker:** on each capture, look back for an open play by the same author +
  primary ticker (90 d) → `play_links` + `resolved-posted`.
- Score refresh nicety: piggyback the marks job to re-query Arctic-Shift for the post's live
  `score`/`num_comments` once at ~24 h (capture-time scores are near-zero — the archive ingests
  posts minutes after creation).
- UI: outcome sparkline + status on the detail page; "resolved by" cross-link.

Gate: a real YOLO play accrues marks across closes; expiry intrinsic finalization unit-tested;
option-feed probe outcome recorded in this doc.

## 8. Slice P6 — agent analysis tooling & polish

- `design/plays-analysis.md`: schema map, canonical SQL, and the **mandatory bias caveats**
  (invariant P5) an analyzing agent must repeat in its output.
- `plays-export` CLI (`pnpm -C packages/worker plays-export -- --from … --to … --format json|csv`)
  → `data/exports/`.
- `deploy/v2/README.md` + ops runbook additions (budget knob, queue-depth logging, media-volume
  sizing ~50 MB/month at measured volume).

## 9. Config additions (`config.toml`)

```toml
[plays]
enabled = true
flairs = ["Gain", "Loss", "YOLO", "Verified Trade"]
queue_interval_s = 60
max_images_stored = 20
max_images_llm = 8
max_image_mb = 10

[plays.llm]
provider = "openai"            # AI-SDK provider id; "anthropic", … later — config-only swap
extract_model = "gpt-5-mini"   # placeholder — pick at P2 against the eval set
interpret_model = "gpt-5-mini"
max_plays_per_tick = 5
daily_budget_usd = 5.0

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
