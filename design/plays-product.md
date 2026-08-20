# WSB Plays — product spec

**Status: APPROVED — IN BUILD (see plays-plan.md for slice progress).** This document defines *what* the Plays
product is and the decisions behind it. The build plan (architecture deltas, schema, slices, order)
lives in [`plays-plan.md`](./plays-plan.md). Both are authoritative in the same sense as the other
`design/` docs: code references them, and doc/code drift is a bug.

## 1. What it is

A browseable archive of **r/wallstreetbets "plays"** — the gain porn, loss porn, and YOLO position
posts that are the subreddit's actual content — each one:

1. **captured** live from the existing Arctic-Shift tap (same 5-minute poll the radar runs),
2. **parsed**: the broker-app screenshot(s) are run through a vision LLM to extract the structured
   position (ticker, instrument, strikes/expiry, size, cost, P&L…),
3. **interpreted**: what the gamble was and how it played out, grounded in evidence the system
   computes deterministically (radar heat/mention history, Alpaca market moves),
4. **categorized** against a fixed taxonomy (dumb luck, high-risk/high-reward, herd-following, …),
5. **summarized** in 2–4 sentences plus a one-line TLDR,
6. **published** automatically to a private web board where plays can be browsed, filtered, and read,
7. **tracked**: open positions (YOLO posts, unrealized gains) are marked to market daily until they
   resolve, expire, or the author posts the outcome.

Framing carries over from the radar: this is **observational research / entertainment, not a trading
signal**, and the UI keeps saying so.

### Relationship to the radar

The heat radar (v2 worker) is **not replaced — it is demoted from "the product" to a data
subsystem** and keeps running unchanged. It matters to Plays twice:

- **Herd evidence.** "Following the herd" is decidable only with mention history: the radar's
  `mentions` table (ticker, author, direction, timestamp) answers *"how many distinct authors posted
  this same position before this play?"* deterministically. The LLM never gets to vibe-check herdness.
- **Trend context.** "TSLA was #2 by heat with 41 authors when this was posted" is radar output and
  appears on every play's detail page.

The heat board stays as a secondary page in the web app; the plays browser becomes the primary surface.

## 2. Decisions record (interview, 2026-08-18)

| Decision | Choice |
|---|---|
| Repo | Same repo; monorepo grows a plays pipeline; radar keeps running. Python oracle tree pruned from `main` (recoverable at tag `v0.0.1`) — see plan §2. |
| Web stack | Keep Nuxt 4; plays UI added to `packages/web`. Heat board stays as a secondary page. |
| LLM | **OpenAI first, provider-agnostic by design** — a thin `PlayAnalyzer` seam over the Vercel AI SDK; provider/model are config strings. |
| Capture scope | **Flair-gated**: `Gain`, `Loss`, `YOLO` (+ `Verified Trade`, see §3) — with or without image. No engagement threshold. |
| History | **Live-forward only.** No backfill (the pipeline shouldn't preclude one later, but nothing is built for it). |
| Publish flow | **Auto-publish with confidence badges.** No moderation queue; low-confidence plays publish but are filtered down by default in the UI. |
| Audience | **Private / home-LAN**, same deploy model as today. No auth, no hardening for public exposure. |
| Enrichment | **Free sources only**: Alpaca (already integrated) + radar data. No paid APIs; anything else is best-effort. |
| Outcomes | **Track in v1**: daily mark-to-market for open positions + author-followup resolution linking. |
| Slice order | **P0 (prune + Dependabot cleanup) leads** — confirmed after review pushback (GPT-5.6 objected, Kimi endorsed; owner decided 2026-08-18). |
| Topology | **Plays loops in the same worker process** (dedicated pool + §1 isolation rules); a second process is the documented escape hatch, not the default. |
| LLM budget/model | **Deferred to P2.** The shipped fail-closed price placeholders and `$5/day` default stand until the P2 eval; not a locked decision. |
| Old radar roadmap | Phase-3 remnants (STEALTH detection, alerts) **parked indefinitely** — not tracked, not deleted. |
| Work tracking | **GitHub Issues**: one issue per slice (P0–P6) with its checklist + gate, under milestone "WSB Plays v1". |

## 3. What counts as a play (capture contract)

A post captured by the existing poll qualifies when `link_flair_text` is in the configured set —
default `["Gain", "Loss", "YOLO", "Verified Trade"]`. (`Verified Trade` is a small improvisation
beyond the interview answer: it is WSB's mod-verified play flair, low-volume and exactly on-topic;
drop it from config if unwanted.)

Measured volume (Arctic-Shift sample, 2026-08-18): ~100 posts per 15 h on the sub, of which
Gain+Loss+YOLO ≈ 28 % → **roughly 45 candidate plays/day**. This bounds LLM cost (see plan §7).

Per candidate, media falls into these shapes (the first three verified live):

| Shape | How it arrives | Handling |
|---|---|---|
| Single image | `url` = `i.redd.it/….jpeg` | download directly |
| Gallery | `url` = `reddit.com/gallery/<id>`, `is_gallery: true` — **Arctic-Shift archives `gallery_data` + `media_metadata` for fresh posts** (P1 gate finding, 2026-08-18; the earlier "null" observation was from stale archives) | resolve locally from the archived dict (order from `gallery_data`, ext from `media_metadata` mime); Reddit's public post JSON (`permalink` + `.json`) is the fallback for a metadata-less raw — it 403s non-browser clients (verified at P1), so that path usually degrades to text-only |
| Inline images in a self-post | text post with `media_metadata` present (images embedded in `selftext`) | resolve like a gallery — don't silently drop to text-only `[prevalence unverified — measure at P1]` |
| Text-only | `url` empty or self-permalink, no media | no vision step; the play is analyzed from title + selftext alone |

**Images are archived to disk at capture** (shared volume). Reddit deletes/removes gain-porn posts
routinely; live-forward capture is the one moment the media is reliably there. Media failure
(deleted, 404, video) degrades the play to text-only with lowered confidence — it never drops it.

Out of scope for v1: plays living in comments, video/GIF posts (kept as text-only), crossposts,
posts under other flairs (`DD`, `Discussion`) even when they contain position screenshots.

## 4. Pipeline stages (product view)

Statuses advance `captured → media_ready → extracted → published` (interpret + denormalize +
publish are ONE stage advance — plan §5 pins them into a single row update), with `failed` as the
only off-ramp — and only after bounded retries (media state is tracked separately; a media failure
degrades the play to text-only, it doesn't park it). Each play is processed by a queue that is
**structurally isolated and budget-capped so the radar cycle is never delayed or broken by LLM
trouble** (invariants P1/P9, §8).

### 4.1 Extraction (vision)

One structured-output call: screenshot(s) + title + selftext → a versioned `PlayExtraction` object
(zod schema; the shape is pinned in plan §4):

- screenshot kind (single position / portfolio / order ticket / chart / none),
- broker if identifiable,
- positions — **one entry per leg** (a spread is N legs, never a single row: marking a debit
  spread as its long leg alone reports unbounded phantom gains): ticker, instrument
  (`shares|call|put|other`), **side (`long|short`)** — distinct from this repo's bull/bear
  `direction`, which is *derived* (a sold put is short **and** bullish; conflating them inverts
  P&L on a very common WSB position) — strike, **full expiry date** (screenshots show "1/17"; the
  extractor resolves the year or leaves it null — OCC symbols need `YYMMDD`), quantity, avg price,
  cost basis, current value, P&L ($ and %), realized vs unrealized. Each leg carries a **stable
  `position_id`** (marks and partial-close tracking key on it). **`quantity` is always positive;
  `side` carries the sign** — one pinned convention, because a double-negative in spread-sum math
  is the same class of landmine as the multiplier. Option prices are per-share with the ×100
  contract multiplier applied only in downstream math — the schema pins the convention so marks
  can't be off by exactly 100×. Also per position: **`opened_at`** (the position-open date shown on
  most broker screenshots — the evidence anchor, §4.2) and **`currency`** (non-USD broker
  screenshots are common; marking them against US quotes without flagging would be silently wrong
  — non-USD positions are `untrackable` in v1),
- the play's overall bull/bear **direction is derived by a defined function**, not left to the
  model: each leg maps to a directional sign (long stock/long call/short put → bullish; short
  stock/long put/short call → bearish), the play takes the majority sign weighted by cost basis,
  and mixed/hedged books resolve to `neutral` — which the herd measure treats as no-match,
- per-field and overall confidence.

This shape is **pinned against the P5 marking math before P2 lands** — plays extracted with a
weaker schema would need a paid full re-run when outcome tracking arrives.

A deterministic **validation pass** follows in TS (not the LLM), with **three outcomes**:
`validated` (whitelist / `ticker_names` hit), `known-non-equity` (index/futures/crypto underlyings
— SPX, NDX, VIX, /ES, BTC — absent from the Alpaca `us_equity` whitelist *by construction*, yet
staples of exactly these flairs; normal confidence, flagged untrackable-by-Alpaca), and
`unvalidated` (confidence downgrade). P&L is cross-checked arithmetically (`pnl ≈ value − cost`,
tolerance); failures downgrade confidence. **The system never silently invents a ticker**
(invariant P3). Published confidence is **derived primarily from this deterministic pass** (ticker
outcome, arithmetic consistency, media presence); the model's self-reported confidence is one
input, not the number — LLM self-confidence is poorly calibrated.

### 4.2 Interpretation & categorization (text)

A second structured-output call whose prompt contains only **evidence the system assembled**:

- the validated extraction,
- post title + selftext,
- **radar evidence** (deterministic), anchored at the right *moment*: a Gain/Loss post documents a
  trade opened **days or weeks before the post** — only YOLO posts have post-time ≈ position-time.
  Evidence computed at post time would describe the attention state of an irrelevant moment and let
  the herd gate fire on chatter that postdates the trade's entry. So: **extraction captures the
  position-open date** (`opened_at` — visible on most broker screenshots) and evidence windows
  anchor there when present; post-time anchoring is the fallback and is **badged as weaker
  evidence**. Window semantics: the **last complete radar window at or before the anchor**, where
  "complete" requires a LATER `cycle_runs` row to exist (the first cycle of the next bucket is
  what finalizes W−1 — a bare `max(window_start)` read can catch features that are still being
  rewritten), with a **staleness bound**: if the newest complete
  window is more than a few hours older than the anchor (radar outage), the chip reads "heat
  evidence unavailable" rather than serving stale context. The **herd measure**, precisely:
  count of **distinct authors** (not posts — WSB serial-reposters would fabricate a herd) of prior
  posts (`thing_type = 'post'`, flair in the plays set) on the same ticker with the same derived
  direction in the trailing 72 h before the anchor, **excluding the play's own author**.
  `known-non-equity` underlyings (SPX, /ES, …) never enter the whitelist-gated `mentions` table,
  so their radar evidence is structurally absent — shown as "unavailable", and `herd-following` is
  unassignable for them. Plus: mentions/distinct authors over trailing 24 h/72 h,
- **market evidence** (Alpaca, free tier): day/5-day return, rvol (low-confidence flag carried
  over), movers-list membership around the post date.

The model may add background from its own knowledge (e.g. "this was earnings week") but must label
it `model-recalled, unverified` — free-sources-only means there is no earnings-calendar API to check
against, so recalled events are displayed as such.

Output: thesis (what the gamble was), outcome note (how it went, per the screenshot), context,
category, tags, summary, TLDR, confidence.

### 4.3 Taxonomy (v1)

Exactly one **primary category** per play, plus free multi-tags. Versioned (`taxonomy_version`) so
re-runs stay comparable.

| Category | Meaning |
|---|---|
| `dumb-luck` | low-probability bet that hit (or missed) with no discernible edge |
| `high-risk-high-reward` | deliberate asymmetric bet, knowingly taken (0DTE, far-OTM, heavy leverage) |
| `herd-following` | position matches a preceding wave — **assignable only when the radar herd evidence clears the configured threshold** (invariant P4; the LLM cannot apply it on vibes) |
| `earnings-gamble` | position held across an earnings/binary event |
| `bag-holding` | riding a long-standing loser |
| `disciplined-play` | sized, hedged, or genuinely thesis-driven (rare, that's the point) |
| `unclassifiable` | extraction too weak to categorize — still published, badged, hidden by default filter |

Tags (open set, seeded): `0dte`, `weeklies`, `far-otm`, `leveraged-etf`, `meme-stock`, `index-bet`,
`earnings`, `full-port`, `margin`, `gain-porn`, `loss-porn`.

### 4.4 Outcome tracking

Plays whose position is open (YOLO posts; any extraction with `realized: false`) get tracked:

- **Mark-to-market on trading days** — gated on Alpaca's `/v2/calendar`, run ≥ 30 min after the
  session close (a fixed UTC tick drifts with DST and duplicates marks on holidays): shares →
  Alpaca daily close (free tier = thin IEX; marks carry a per-feed confidence flag the way
  `rvol_conf` does); options → contract mark from the free indicative snapshot. When a far-OTM
  contract has no quote — likely common at WSB strikes; the Phase 0.2 probe verified Greeks/IV "on
  liquid strikes" only — **intrinsic value is recorded as a floor, never drawn as a price point
  pre-expiry** (a live 30-DTE OTM call is not worth −100 %). At expiry → intrinsic, status
  `expired`. Marks are **per position** (`position_id`), not per play — a portfolio play holding
  shares *and* options cannot be represented by one row with one source/confidence; play-level P&L
  is the sum over its positions' marks. **Corporate actions**: a split between capture and a mark
  makes the pre-split cost basis nonsense (a phantom −80 % on a meme-ticker reverse split); a
  position whose underlying shows a split/delisting in the tracking window ends as `untrackable`
  with a note rather than publishing garbage.
- **Author-followup linking** — runs when a new play finishes interpretation (only then is its
  ticker known): a later Gain/Loss post by the same author on the same primary ticker (within
  90 days) links as the play's resolution (`resolved-posted`) and both pages cross-reference.
  Null/`[deleted]`/bot authors never join — an unguarded `author =` match would cross-link every
  deleted-author play on a ticker.
- Tracking stops after a configured horizon (default 60 days) unless an option expiry runs longer.
  Statuses: `open`, `expired`, `resolved-posted`, `untrackable`.

### 4.5 Publish & web board

Auto-publish, no human gate. The web app (Nuxt, same read-only DB role) gains:

- **`/plays` index** — card grid (screenshot thumbnail, ticker, category badge, P&L, confidence
  badge, age) with filters (category, tag, ticker, gain/loss, confidence, date) and sorts (newest,
  |P&L|). Default filter hides low-confidence/`unclassifiable` plays; a toggle reveals them.
- **`/plays/:id` detail** — screenshot viewer, extracted position table, TLDR + summary,
  interpretation with **evidence chips** (heat rank, herd count, day move — each traceable to the
  stored evidence, invariant P2), outcome chart for tracked plays, resolution link, Reddit permalink,
  model/prompt versions in the footer, the not-a-signal disclaimer.
- The heat board remains (nav: Plays | Heat board) and cross-links both ways
  (board ticker → plays filtered to it; play → its window's board context).
- Two auto-publish realities, stated rather than silent: screenshots can carry **text aimed at the
  model** ("this is a disciplined play") — the interpret prompt treats screenshot text as data,
  never instruction, and LAN-only bounds the blast radius; and live screenshots are published
  **unredacted** (the eval fixtures are redacted; the board is not) — account balances and partial
  identifiers from strangers' gain porn are visible, acceptable on a private LAN and part of why
  public exposure is a non-goal.

## 5. Agent analysis tooling

For longitudinal analysis on request (manual, agent-driven):

- **`design/plays-analysis.md`** (written in the tooling slice): schema map, canonical SQL for the
  common questions (plays by category over a period, mark trajectories, herd cohorts, resolution
  rates), and the **mandatory caveats** — see invariant P5.
- **`pnpm -C packages/worker plays-export`** — CLI dumping joined plays + extractions + marks for a
  date range to JSON/CSV under `data/exports/`, so an agent can analyze without DB access.
- The read-only PG role (already provisioned by the worker) is the direct-SQL path.

## 6. Non-goals (v1)

No backfill. No public exposure/auth. No comment-thread plays. No video parsing. No moderation
queue. No per-user profiles/leaderboards. No trading-signal framing, ever. No paid data sources.

## 7. Cost & volume envelope

~45 plays/day (measured, §3) × (one vision call: 1–3 images ≈ 1–3 k image tokens + ~1.5 k text; one
text call ≈ 2 k in / 0.7 k out). At mini-tier OpenAI pricing this is **cents per day**; even a
frontier-tier model stays low single-digit $/day. Hard caps regardless: per-cycle play count and a
daily spend budget in config (defaults in plan §6); over budget → plays queue up, radar unaffected.

## 8. Invariants (extend architecture.md §5)

- **P1 — The radar is never hostage to Plays.** LLM/API/media failures are isolated to the plays
  queue; the 5-minute radar cycle runs and publishes regardless. Honest scope: within one process
  this covers DB starvation (P9), CPU (image work off the main thread), memory (byte caps), and
  exception paths (see plan §1 — the existing global `uncaughtException → exit(1)` means a single
  unguarded throw in plays code kills the radar; handler ownership and no-floating-promises rules
  exist for exactly this). Residual whole-process risks (OOM, disk full) are accepted and named;
  if P1 proves leaky in practice, the escape hatch is moving the plays loops into a second process
  — the schema and queue design don't care.
- **P2 — Every published label is evidence-backed.** Extraction JSON, the assembled evidence block,
  and model/prompt/taxonomy versions are stored per play; nothing on the board is unexplainable.
- **P3 — Tickers are validated, never invented.** Whitelist/`ticker_names` validation gates every
  extracted symbol; failures mean low confidence, not a made-up ticker on the board.
- **P4 — `herd-following` requires deterministic radar evidence** above the configured threshold.
  Enforced structurally: the category enum offered to the model excludes it below threshold; the
  prompt additionally bars herd claims in free-text tags/summaries.
- **P5 — Selection bias is always surfaced.** WSB self-reports wins far more than losses. Aggregate
  statistics (category win rates, average P&L) must carry the bias caveat, and the per-post outcome
  rule from the radar ("never aggregate to a per-ticker win rate") extends to plays verbatim.
  *(A documentation norm for humans and analyzing agents — unlike P3/P4/P6/P8/P9 it is not
  code-enforceable; the analysis how-to doc carries it.)*
- **P6 — Spend is capped, fail-closed.** Per-tick count + daily budget, priced from config; the
  failure mode is a growing queue, never a surprise bill. Enforceability requires three things the
  cap is worthless without: **zero/missing prices refuse dispatch** (a shipped `0.0` placeholder
  must halt the queue loudly, not meter $0 forever); the daily counter is **derived from DB-summed
  `cost_usd`** (an in-memory counter re-opens the cap on every restart); and pre-dispatch
  enforcement reserves the **worst case** (input tokens + the configured `max_output_tokens`) —
  output cost is unknowable before the call returns, so the cap is a bounded estimate, and the doc
  says so.
- **P7 — Media is archived at capture** (Reddit deletes); media failure degrades to text-only
  analysis with lowered confidence, never a dropped play — and a *transient* fetch failure is
  retried before degrading.
- **P8 — Processing is idempotent per (play, stage, version), with a bounded billing tail.** The
  5-min poll re-delivers every candidate ~12×; the plays insert is `ON CONFLICT DO NOTHING` and no
  writer ever moves `status` backwards — including reprocessing, which runs as a separate path
  that leaves the row `published` (old pointers serve until the new child rows commit and the
  pointers advance). Honest limit: an LLM call is an external side effect that cannot commit
  atomically with Postgres — a crash between a completed call and its child-row+status
  transaction re-charges that stage on retry, bounded by `max_attempts`. Each stage's child insert
  + status advance + cost row land in **one transaction** (the call itself stays outside any tx,
  per P9), which makes that tail the *only* double-charge path.
- **P9 — Plays code never holds a DB transaction or pooled client across a network/LLM call**, and
  the plays loops run on their own PG pool. This — not `try/catch` walls — is what makes P1 true.
