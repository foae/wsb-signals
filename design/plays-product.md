# WSB Plays — product spec

**Status: DESIGN (approved direction, pre-implementation).** This document defines *what* the Plays
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

## 3. What counts as a play (capture contract)

A post captured by the existing poll qualifies when `link_flair_text` is in the configured set —
default `["Gain", "Loss", "YOLO", "Verified Trade"]`. (`Verified Trade` is a small improvisation
beyond the interview answer: it is WSB's mod-verified play flair, low-volume and exactly on-topic;
drop it from config if unwanted.)

Measured volume (Arctic-Shift sample, 2026-08-18): ~100 posts per 15 h on the sub, of which
Gain+Loss+YOLO ≈ 28 % → **roughly 45 candidate plays/day**. This bounds LLM cost (see plan §7).

Per candidate, media falls into three verified shapes:

| Shape | How it arrives | Handling |
|---|---|---|
| Single image | `url` = `i.redd.it/….jpeg` | download directly |
| Gallery | `url` = `reddit.com/gallery/<id>`, `is_gallery: true` — **Arctic-Shift archives `media_metadata` as `null`** (verified live), so the image list is NOT in the archive | resolve via Reddit's public post JSON (`permalink` + `.json`) at capture time — the post is ~5 min old, so this works live-forward; fallback on failure: text-only |
| Text-only | `url` empty or self-permalink | no vision step; the play is analyzed from title + selftext alone |

**Images are archived to disk at capture** (shared volume). Reddit deletes/removes gain-porn posts
routinely; live-forward capture is the one moment the media is reliably there. Media failure
(deleted, 404, video) degrades the play to text-only with lowered confidence — it never drops it.

Out of scope for v1: plays living in comments, video/GIF posts (kept as text-only), crossposts,
posts under other flairs (`DD`, `Discussion`) even when they contain position screenshots.

## 4. Pipeline stages (product view)

Statuses advance `captured → extracted → analyzed → published` (with `media_failed`, `failed`,
`skipped` off-ramps); each play is processed by a queue that is **error-isolated and budget-capped
so the radar cycle is never delayed or broken by LLM trouble** (invariant P1, §8).

### 4.1 Extraction (vision)

One structured-output call: screenshot(s) + title + selftext → a versioned `PlayExtraction` object
(zod schema; the shape is pinned in plan §4):

- screenshot kind (single position / portfolio / order ticket / chart / none),
- broker if identifiable,
- positions: ticker, instrument (`shares|call|put|spread|other`), direction, strike/expiry,
  quantity, avg price, cost basis, current value, P&L ($ and %), realized vs unrealized,
- per-field and overall confidence.

A deterministic **validation pass** follows in TS (not the LLM): tickers are checked against the
whitelist / `ticker_names`; P&L is cross-checked arithmetically (`pnl ≈ value − cost`, tolerance);
failures downgrade confidence. **The system never silently invents a ticker** — an unvalidated
symbol keeps the play at low confidence (invariant P3).

### 4.2 Interpretation & categorization (text)

A second structured-output call whose prompt contains only **evidence the system assembled**:

- the validated extraction,
- post title + selftext,
- **radar evidence** (deterministic): heat rank and SoV at the posting window; mentions/distinct
  authors over trailing 24 h/72 h; count of *prior* same-ticker, same-direction position posts in
  the trailing 72 h (the herd measure),
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

- **Daily mark-to-market** after US close: shares → Alpaca daily close; options → contract mark
  from the free indicative options snapshot (Greeks/IV feed), falling back to intrinsic value off
  the underlying when the contract quote is unavailable; at expiry → intrinsic, status `expired`.
- **Author-followup linking**: a later Gain/Loss post by the same author on the same primary ticker
  (within 90 days) links as the play's resolution (`resolved-posted`) and both pages cross-reference.
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
  queue; the 5-minute radar cycle runs and publishes regardless.
- **P2 — Every published label is evidence-backed.** Extraction JSON, the assembled evidence block,
  and model/prompt/taxonomy versions are stored per play; nothing on the board is unexplainable.
- **P3 — Tickers are validated, never invented.** Whitelist/`ticker_names` validation gates every
  extracted symbol; failures mean low confidence, not a made-up ticker on the board.
- **P4 — `herd-following` requires deterministic radar evidence** above the configured threshold.
- **P5 — Selection bias is always surfaced.** WSB self-reports wins far more than losses. Aggregate
  statistics (category win rates, average P&L) must carry the bias caveat, and the per-post outcome
  rule from the radar ("never aggregate to a per-ticker win rate") extends to plays verbatim.
- **P6 — Spend is hard-capped** (per-cycle count + daily budget); the failure mode is a growing
  queue, never a surprise bill.
- **P7 — Media is archived at capture** (Reddit deletes); media failure degrades to text-only
  analysis with lowered confidence, never a dropped play.
