# Reddit data-access strategy

> How WSB Signals gets Reddit data. **Project decision (2026-06-03): the official Reddit API is
> excluded** (no longer free/open — OAuth + mandatory 2025 pre-approval). WSB Signals runs on the
> community archive "taps". **Empirically (probe 2026-06-03), only Arctic-Shift works for recent
> data — PullPush's ingestion is frozen at 2025-05-19.** This doc records that and its
> consequences.

## ⚡ Verified 2026-06-03 — `scripts/probe_reddit_taps.py`

| Tap | Newest r/wallstreetbets item | Verdict |
|---|---|---|
| **Arctic-Shift** | posts **~4 min** old · comments **~seconds** old | ✅ **near-real-time — build on this** |
| **PullPush** | **2025-05-19** (~380 days stale) · 24 s/query | ⛔ **ingestion frozen** |

PullPush returns the *same* `2025-05-19 13:06` cutoff for all-Reddit posts, all-Reddit comments,
**and** r/AskReddit → the halt is **global, not a WSB quirk**. So **PullPush is unusable for any
data after 2025-05-19** — not for the live radar, not for recent backfill, and its "Reddit-wide
FTS" edge is moot for current data. It remains valid only for **historical ≤2025-05-19** lookups
(and is slow). **Re-run the probe before relying on PullPush; it may recover** (the probe script,
`scripts/probe_reddit_taps.py`, now lives at tag `oracle-final` — pruned from `main` in Plays P0).

This also confirms the headline feasibility question: **Arctic-Shift content latency is seconds-to-
minutes** → the live radar is viable. (Scores are still `0/1` for ~36 h — the engagement lag, §3.)

## TL;DR (the decision)

| Job | Use | Why |
|---|---|---|
| **Live ingestion** (fresh posts/comments) | **Arctic-Shift** (poll `search`) | Only tap with recent data; ~real-time content; high throughput. |
| **Cold-start backfill & rolling baselines** | **Arctic-Shift** (download-tool dump + `/aggregate` + `/time_series`) | Free bulk history; one call gives mention series & the activity denominator. |
| **Reddit-wide FTS / live fallback** | **None currently** | PullPush (the only Reddit-wide-FTS tap) is frozen; the Reddit API is excluded → **single-source risk**, see below. |
| **Historical ≤2025-05-19 / Reddit-wide FTS of old data** | **PullPush** (if it responds) | Still valid for the pre-freeze window. |
| **Live upvote/comment velocity** | **Not available** (§3) | Taps report `score`/`num_comments` wrong for ~36 h → post-hoc enrichment only. |
| **Discord** | **Deferred** (pluggable source) | No ToS-friendly read API — [`wallstreetbets.md` §9](./wallstreetbets.md). |

## The taps (and the one we're not using)

1. **Arctic-Shift** — community archive + query API + monthly dumps.
   [`arctic-shift-api.md`](./arctic-shift-api.md). No auth, free, high throughput, `limit=auto`,
   aggregations & `time_series`. **Content archived at post time (verified ~real-time); engagement
   lags ~36 h.** → our **sole primary** tap.
2. **PullPush** — Pushshift successor. [`pullpush-api.md`](./pullpush-api.md). Reddit-wide FTS, no
   auth. **⛔ Ingestion frozen at 2025-05-19 (verified 2026-06-03) and slow** → currently only good
   for old historical data; **re-test before relying**.
3. **Official Reddit Data API** — *evaluated and excluded.* Real-time/authoritative but not
   free/open (OAuth + 2025 pre-approval; non-commercial ≤100 QPM; commercial billed). **The only
   other source of *recent* data → the upgrade path if Arctic-Shift becomes insufficient.**

## Comparison matrix

| Dimension | Arctic-Shift ✅ | PullPush ⛔ | Reddit API ❌ (excluded) |
|---|---|---|---|
| Content freshness | **~real-time** (verified) | **FROZEN @ 2025-05-19** | Real-time |
| Engagement freshness | Wrong ~36 h | Stale | Live |
| Latency / speed | 168–800 ms | ~24 s (slow) | fast |
| FTS scope | One subreddit/author | **Reddit-wide** (but pre-freeze data only) | Limited |
| Aggregations / time-series | **Yes** | No | No |
| Bulk history | **Dumps** | Slow, ≤2025-05-19 | Slow |
| Rate limit | ~2000/min; sends `X-RateLimit-*` | 15–30/min, 1000/hr | 100 QPM |
| Auth / access | None | None | OAuth + pre-approval |
| Cost | Free | Free | Free non-commercial / paid |
| **Role here** | **Primary live + backfill + aggregates** | **Old-history only (currently down)** | **Not used** |

## 3. What scrapers-only costs the radar (still applies)

- **Content is live-ish** (verified): post/comment **text, author, flair, timestamps** are present
  near-real-time → `mentions, authors, sov, velocity, accel, z, direction-from-text, flair_counts,
  dd_count` are all computable live.
- **Engagement is NOT live:** `score`/`num_comments` read `0`/`1` until ~36 h after posting (probe
  confirmed: 22–24/25 fresh items had score 0/1). So **live upvote-velocity / `eng_per_mention`
  are post-hoc enrichments**, not live inputs. The live **`H_e`** ranks on mention-based signals —
  see [`../design/signal-framework.md`](../design/signal-framework.md) §2.5/§5/§10.

## <a name="single-source-risk"></a>4. Single-source risk (new, because PullPush is down)

With PullPush frozen and the Reddit API excluded, **Arctic-Shift is the only source of recent WSB
data.** If it degrades or goes down, the live radar has **no free fallback**. Mitigations, in order:
1. **Monitor** Arctic-Shift's `X-RateLimit-*` headers + a heartbeat on the probe; alert on
   staleness (newest-item lag spikes).
2. **Re-test PullPush periodically** (the probe) — if it un-freezes, it returns as a fallback.
3. **Keep the Reddit API as the documented break-glass** upgrade (accept its OAuth/approval cost)
   if Arctic-Shift can't carry the project.
4. Don't over-poll Arctic-Shift (be a good citizen of a free service); cache aggressively.

## 5. Rate-limit budget

- **Arctic-Shift (primary):** generous (~2000/min observed; sends `X-RateLimit-Remaining`/`Reset`
  — probe saw ~999 remaining). Single-subreddit poll every 5 min with `limit=auto` is well
  within budget. Use `/aggregate` to get counts in one call.
- **PullPush:** n/a for live (frozen). If used for old history: soft 15/min, hard 30/min, 1000/hr;
  pace ≥1 req/4 s, single worker, expect ~24 s responses.
- **Market data (Alpaca — settled):** separate budget, 200 calls/min free
  ([`market-data-access.md`](./market-data-access.md)).

## 6. Cold-start recipe (Phase 4 — v0.0.1 is forward-only)

**v0.0.1 ranks on `sov`, which needs no history**, and warms `z` **forward-only** (no backfill);
`z` switches on per ticker once its baseline is `ready`. The seeding below is the **Phase-4
option** to make `z` trustworthy sooner, plus the post-hoc engagement reconciliation.

1. **Seed history (Phase-4 option):** pull the last *N* days of r/wallstreetbets via the
   **Arctic-Shift download-tool** (single-subreddit dump) or paged `search`. (PullPush can't help —
   frozen.) Compute per-ticker baseline mention rates (mean/std by hour-of-week) and the activity
   denominator (`time_series?key=r/wallstreetbets/comments/count`).
2. **Go live (v0.0.1):** start the Arctic-Shift poll loop (new posts + Daily Discussion Thread
   comments) every 5 min.
3. **Reconcile (Phase 4, scheduled):** for items >36 h old, re-fetch `score`/`num_comments` from
   Arctic-Shift to populate the (post-hoc) engagement features → *settled* `H_e`.

## 7. Source-abstraction note

Ingestion sits behind one `Source` interface (`fetch_posts`, `fetch_comments`, `poll`,
`backfill`). Arctic-Shift is the live impl; PullPush is a (currently-dormant) historical/fallback
impl; a future Discord connector and the Reddit API break-glass slot in without rework. See
[`../design/architecture.md`](../design/architecture.md).
