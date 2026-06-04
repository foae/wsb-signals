# PullPush.io — Reddit Search API (offline reference)

> Source of truth: <https://pullpush.io/> (homepage hosts the docs), the PullPush API
> Forum <https://forum.pullpush.io/>, and the BAScraper wrapper's empirically-measured
> rate-limit notes. Captured 2026-06-03. **No SLA/SLO — endpoints, limits, and availability
> can change without notice.**

## What it is

PullPush is a **free, third-party, read-only search API over historical Reddit data**. It is
the de-facto community successor to **Pushshift** after the [2023 Reddit API
controversy](https://en.wikipedia.org/wiki/2023_Reddit_API_controversy), which restricted
Pushshift to Reddit admins only and crippled the old wrappers (PSAW/PMAW). PullPush rebuilds
a Pushshift-style search surface on top of Bittorrent data dumps (credited to Reddit user
**Watchful1**, who compiles the monthly dumps).

Key properties:
- **Read-only.** You search/retrieve archived submissions and comments. You cannot write.
- **No authentication.** Plain HTTPS GET requests, no API key, no OAuth.
- **Reddit-wide full-text search (FTS).** Unlike Arctic-Shift, the `q`/`title`/`selftext`
  keyword search works across *all* of Reddit, not just within one author/subreddit. This is
  PullPush's main advantage for cross-subreddit ticker hunting.
- **Historical, not live.** Data comes from archived dumps + ongoing ingestion. Scores and
  comment counts reflect the moment of archival, not current values (use the live Reddit API
  if you need up-to-the-minute scores).
- **Unofficial.** Not endorsed by Reddit. Subject to change/discontinuation.

By using the API you agree to the PullPush Terms of Service (linked from the homepage).

## Base URL & endpoints

Base: `https://api.pullpush.io`

| Purpose | Endpoint | Notes |
|---|---|---|
| Search comments | `GET /reddit/search/comment/` | Primary comment search |
| Search submissions | `GET /reddit/search/submission/` | Primary submission (post) search |
| Comments by ID (alias) | `GET /reddit/comment/search?ids=...` | Batch fetch by base36 id |
| Get all comment IDs for a submission | `GET /reddit/search/comment/?link_id=<submission_id>` | Returns array of comment ids under a post |

> Note: the homepage shows both `/reddit/search/comment/` and the alias form
> `/reddit/comment/search`. They resolve to the same comment search. Prefer the
> `/reddit/search/comment/` and `/reddit/search/submission/` forms.

All responses are JSON. Actual records are under the **`data`** key; search diagnostics are
under the **`metadata`** key (see [Response format](#response-format)).

## Comment search parameters

`GET https://api.pullpush.io/reddit/search/comment/`

| Parameter | Type | Default | Accepted values | Description |
|---|---|---|---|---|
| `q` | String | — | string / `"quoted phrase"` | Search term in the comment **body**. Case-insensitive. |
| `ids` | String | — | comma-delimited base36 ids | Retrieve specific comments by id. |
| `size` | Integer | `100` | integer, **max 100** | Number of results to return. |
| `sort` | String | `desc` | `asc`, `desc` | Sort order. |
| `sort_type` | String | `created_utc` | `score`, `num_comments`, `created_utc` | Attribute to sort by. |
| `author` | String | — | username (no `u/`) | Restrict to a specific author. |
| `subreddit` | String | — | subreddit name (no `r/`) | Restrict to a specific subreddit. |
| `after` | Epoch / relative | — | epoch seconds **or** `<n>{s,m,h,d}` | Results created after this time. |
| `before` | Epoch / relative | — | epoch seconds **or** `<n>{s,m,h,d}` | Results created before this time. |
| `link_id` | String | — | base36 id | Restrict to comments under a particular submission. |

## Submission (post) search parameters

`GET https://api.pullpush.io/reddit/search/submission/`

| Parameter | Type | Default | Accepted values | Description |
|---|---|---|---|---|
| `ids` | String | — | comma-delimited base36 ids | Retrieve specific submissions by id. |
| `q` | String | — | string / `"quoted phrase"` | Search **all** fields (title + selftext). Case-insensitive. |
| `title` | String | — | string / `"quoted phrase"` | Search the **title** field only. |
| `selftext` | String | — | string / `"quoted phrase"` | Search the **selftext** (body) field only. |
| `size` | Integer | `25`¹ | integer, **max 100** | Number of results to return. |
| `sort` | String | `desc` | `asc`, `desc` | Sort order. |
| `sort_type` | String | `created_utc` | `score`, `num_comments`, `created_utc` | Attribute to sort by. |
| `author` | String | — | username | Restrict to a specific author. |
| `subreddit` | String | — | subreddit name | Restrict to a specific subreddit. |
| `after` | Epoch / relative | — | epoch seconds **or** `<n>{s,m,h,d}` | Results created after this time. |
| `before` | Epoch / relative | — | epoch seconds **or** `<n>{s,m,h,d}` | Results created before this time. |
| `score` | Integer / operator | — | `100`, `>100`, `<25` | Filter by score. URL-encode `>`/`<`. |
| `num_comments` | Integer / operator | — | `100`, `>100`, `<25` | Filter by number of comments. |
| `over_18` | Boolean | both | `true`, `false` | NSFW / SFW filter. |
| `is_video` | Boolean | both | `true`, `false` | Video / non-video filter. |
| `locked` | Boolean | both | `true`, `false` | Locked / unlocked threads. |
| `stickied` | Boolean | both | `true`, `false` | Stickied / non-stickied. |
| `spoiler` | Boolean | both | `true`, `false` | Spoiler filter. |
| `contest_mode` | Boolean | both | `true`, `false` | Contest-mode filter. |

> ¹ The homepage text is internally inconsistent on the submission default `size`: the prose
> says "After running this search, 25 results are returned… default", while the parameter
> table lists `100`. **Treat the submission default as ambiguous and always pass `size`
> explicitly.** (Comment search default is consistently `100`.)

## Retrieving by ID

Batch-fetch specific comments by their base36 ids:

```
https://api.pullpush.io/reddit/comment/search?ids=dlrezc8,dlrawgw,dlrhbkq
```

Submissions support the same `ids` parameter on `/reddit/search/submission/`.

## Getting every comment ID for a submission

When a post has thousands of comments, this returns the full array of comment ids under it
(you can then hydrate them here or via the live Reddit API — the live API gives current
scores for recent posts):

```
https://api.pullpush.io/reddit/search/comment/?link_id=6uey5x
```

## Time format (`before` / `after`)

Both accept either:
- **Epoch seconds** (e.g. `1270637661`), or
- **Relative offset**: a number followed by `s` (second), `m` (minute), `h` (hour), or
  `d` (day). Example: `after=30d` = last 30 days; `after=4d&before=2d` = the window between 4
  and 2 days ago.

## Score / num_comments operators

`score` and `num_comments` accept a bare integer or a comparison: `score=>100` (more than 100)
or `score=<25` (fewer than 25). Remember to URL-encode `>` (`%3E`) and `<` (`%3C`).

## Response format

```json
{
  "data": [
    {
      "author": "MockDeath",
      "body": "Knowing more would definitely help...",
      "created_utc": 1270637661,
      "id": "c0nn9iq",
      "link_id": "t3_bne3u",
      "parent_id": "t1_c0nn5ux",
      "score": 2,
      "subreddit": "askscience",
      "subreddit_id": "t5_2qm4e"
    }
  ],
  "metadata": {
    "execution_time_milliseconds": 30.52,
    "results_returned": 1,
    "shards": { "failed": 0, "successful": 36, "total": 36 },
    "size": 1,
    "sort": "asc",
    "sort_type": "created_utc",
    "timed_out": false,
    "total_results": 134785,
    "version": "v3.0"
  }
}
```

Programmatic notes:
- **`metadata.total_results`** is the full count matching the query (ignoring `size`) — useful
  as a raw frequency/volume signal without paging through every record.
- **`metadata.timed_out`** — check this; complex queries can time out and silently return
  partial data.
- **`metadata.shards.failed`** — non-zero means partial coverage of the index.
- Comment objects expose `link_id` (parent post, `t3_…`) and `parent_id` (`t1_…` for a reply,
  `t3_…` for a top-level comment), enabling thread reconstruction.

## Rate limits

PullPush introduced rate limiting **as of February 2024**. Empirically (per the BAScraper
wrapper author, since PullPush publishes no formal limits page):

| Limit | Threshold |
|---|---|
| **Soft limit** | after **15 requests / minute** |
| **Hard limit** | after **30 requests / minute** |
| **Long-term hard limit** | **1000 requests / hour** |

Recommended request pacing:
- Avoid the **soft** limit → ~**4 s** sleep between requests.
- Avoid the **hard** limit → ~**2 s** sleep between requests.
- Sustained **1000+ requests** → **3.6–4 s** sleep between requests (the 1000/hr cap is the
  binding constraint for big backfills).

The API returns `x-ratelimit-*` headers (e.g. remaining/reset); read them and throttle.
Due to "lowered performance recently," **a single worker** is recommended for PullPush unless
doing a short burst. The maintainer asks users to respect cool-downs and not request very
large amounts of data (it stresses a free service). **For massive/historical pulls, prefer
Arctic-Shift dumps over hammering this API.**

## Strengths & weaknesses (vs Arctic-Shift)

- **Strength:** Reddit-wide full-text search — find a `$TICKER` across all subreddits in one
  query. Better on *complex* queries per the BAScraper author.
- **Weakness:** Lower throughput, stricter rate limits, single-worker recommended, `size`
  capped at 100. Archival lag means scores/comment counts may be stale.

For WSB Signals we mostly query a **single subreddit** (`subreddit=wallstreetbets`), which
both APIs handle — so Arctic-Shift (higher throughput, `limit=auto`, dumps) is usually the
better primary, with PullPush as a cross-subreddit/FTS fallback. See
[`reddit-data-access.md`](./reddit-data-access.md) for the decision matrix.

## Removals, ToS, contact

- **Removal requests:** ticket system at <https://removals.pullpush.io>. (A Pushshift removal
  does **not** propagate to PullPush — separate request required.)
- **Forum / support:** <https://forum.pullpush.io/> (maintainer posts as `pullpush-actual`).
- **Sister tools:** Reddit Search and Reddit Undelete web UIs are linked from the homepage.

## Quick examples (curl)

```bash
# Most recent r/wallstreetbets submissions mentioning "GME" (FTS across title+selftext)
curl 'https://api.pullpush.io/reddit/search/submission/?q=GME&subreddit=wallstreetbets&size=100'

# Comments in r/wallstreetbets in a 24h window, oldest first, by score
curl 'https://api.pullpush.io/reddit/search/comment/?subreddit=wallstreetbets&after=2d&before=1d&sort_type=score&sort=desc&size=100'

# All highly-upvoted DD posts in WSB (score > 500)
curl 'https://api.pullpush.io/reddit/search/submission/?subreddit=wallstreetbets&score=%3E500&size=100'
```
