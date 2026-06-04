# Arctic-Shift — Reddit data API + bulk dumps (offline reference)

> Source of truth: `api/README.md` and `README.md` in
> <https://github.com/ArthurHeitmann/arctic_shift> (captured verbatim 2026-06-03) plus the
> hosted API at <https://arctic-shift.photon-reddit.com>. **"No uptime or performance
> guarantees" — limits and availability can change at any time.**

## What it is

**Arctic-Shift** is a project by *Arthur Heitmann* (`raiderbv`, author of the Photon Reddit
client) that makes Reddit data "accessible to researchers, moderators and everyone else."
It is, alongside [PullPush](./pullpush-api.md), a primary community successor to Pushshift
after the 2023 Reddit API lockdown. Three ways to consume the data:

1. **Bulk dumps** — large compressed monthly archives (best for massive/historical work).
2. **HTTP API** — hosted query API (this doc's main subject). The author labels it "(limited)."
3. **Web UI** — point-and-click search/builder at
   <https://arctic-shift.photon-reddit.com/search> (good for prototyping a query before coding).

Properties relevant to WSB Signals:
- **Read-only, no auth, JSON over HTTPS GET.**
- **Higher throughput than PullPush** for single-author/single-subreddit queries; supports
  `limit=auto` (100–1000 results/request) and richer endpoints (aggregations, time series,
  comment trees, subreddit rules/wikis, user interactions).
- **FTS is scoped:** keyword search on `title`/`selftext`/`body` works only **in combination
  with an `author` or `subreddit`** (and not for very active users/subreddits). It cannot do
  Reddit-wide free-text search the way PullPush can. For WSB (one subreddit) this is fine.
- **Archival lag:** for ~36 h after posting, `score`/`num_comments` may read `0`/`1`; after
  ~36 h they converge to the values released in the `.zst` dumps.

Base URL: `https://arctic-shift.photon-reddit.com`
Status: <https://status.arctic-shift.photon-reddit.com>
Search UI: <https://arctic-shift.photon-reddit.com/search>

---

## ID lookup

Retrieve things by their id.

- `GET /api/posts/ids`
- `GET /api/comments/ids`
- `GET /api/subreddits/ids`
- `GET /api/users/ids` (see [Users → Search](#users) notes — aggregate data only)

Example — two posts by id: `/api/posts/ids?ids=ei30r4,eitwb3`

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `ids` | `ID[]` | — | Comma-separated list. **Limit: 500** |
| `md2html` | `boolean` | `false` | If `true`, adds generated `selftext_html`/`body_html` |
| `fields` | `string` | — | Comma-separated list of fields to return (see [Selectable fields](#selectable-fields)) |

---

## Posts & comments

### Search

- `GET /api/posts/search`
- `GET /api/comments/search`

Examples:
- `/api/posts/search?sort=asc&after=2019-12-30&subreddit=worldnews&title=wuhan&limit=10`
- `/api/comments/search?author=PresidentObama&link_id=z1c9z&limit=100`

**Common parameters (both posts and comments):**

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `author` | `string` | — | Username (any `u/` prefix is ignored) |
| `subreddit` | `string` | — | Subreddit (any `r/` prefix is ignored) |
| `author_flair_text` | `string` | — | Keyword search; same limitations as `title`/`body` |
| `after` | `Date` | — | Time the thing was posted (see [Date](#date)) |
| `before` | `Date` | — | Time the thing was posted |
| `limit` | `int` (1–100) \| `"auto"` | `25` | `"auto"` returns 100–1000 depending on server capacity |
| `sort` | `asc` \| `desc` | — | Sorted by `created_utc` |
| `md2html` | `boolean` | `false` | Adds `selftext_html`/`body_html` |
| `fields` | `string` | — | Comma-separated list of fields to return |

**Post-only parameters:**

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `crosspost_parent_id` | `ID` | — | |
| `over_18` | `boolean` | — | |
| `spoiler` | `boolean` | — | |
| `title` | `string` | — | Keyword search; **only usable with `author` or `subreddit`** (not for very active users/subreddits) |
| `selftext` | `string` | — | Keyword search; same restriction |
| `link_flair_text` | `string` | — | Keyword search; same restriction |
| `query` | `string` | — | Searches **both** `title` and `selftext`; same restriction |
| `url` | `string` | — | Prefix match (e.g. `youtube.com/xyz` matches `…/xyz?p=abc`) |
| `url_exact` | `boolean` | `false` | If `true`, `url` must match exactly |

**Comment-only parameters:**

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `body` | `string` | — | Keyword search; **only with `author`, `subreddit`, `link_id`, or `parent_id`** (not for very active users/subreddits) |
| `link_id` | `ID` | — | Id of the post |
| `parent_id` | `ID` \| empty | — | Parent comment id; empty = top-level comment |

### Comments tree

- `GET /api/comments/tree`

Returns comments in a nested tree like Reddit displays. If `limit` is exceeded, comments are
**collapsed**: collapsed nodes use `"kind": "more"` with a `children` field listing the
collapsed comment ids (mirroring Reddit's own API). `start_breadth`/`start_depth` decrease by
1 per depth level; comments outside the current breadth/depth are collapsed.

Examples:
- `/api/comments/tree?link_id=t3_7cff0b&parent_id=t1_dppum98&md2html=true`
- `/api/comments/tree?link_id=t3_x8i09x&limit=9999` (all comments under a post)

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `link_id` | `ID` | — | Post id (**required**) |
| `parent_id` | `ID` | — | If unset, all comments under the post are returned |
| `limit` | `int` (1–25000) | `50` | ~`9999` returns essentially all comments |
| `start_breadth` | `int` (≥0) | `4` | Collapsing control |
| `start_depth` | `int` (≥0) | `4` | Collapsing control |
| `md2html` | `boolean` | `false` | Adds `body_html` |

### Aggregations

- `GET /api/posts/search/aggregate`
- `GET /api/comments/search/aggregate`

Aggregate matching results by **date, author, or subreddit**. **All filtering parameters from
the search endpoints are supported** — so this is the single most useful endpoint for WSB
Signals: it returns counts directly instead of forcing you to page through records. Very
active users/subreddits may time out.

Examples:
- Comment frequency of u/spez per year:
  `/api/comments/search/aggregate?aggregate=created_utc&frequency=year&author=spez&after=2006-01-01`
- Most active posters in r/announcements:
  `/api/posts/search/aggregate?aggregate=author&subreddit=announcements`

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `aggregate` | `created_utc` \| `author` \| `subreddit` | — | What to group by |
| `frequency` | `string` (interval) | — | **Required** when `aggregate=created_utc` (e.g. `hour`, `day`, `week`, `month`, `year`) |
| `limit` | `int` (≥1) \| empty | empty | Empty (`limit=`) = no limit |
| `min_count` | `int` (≥0) | — | Not used with `aggregate=created_utc` |
| `sort` | `asc` \| `desc` | `asc` for `created_utc`, else `desc` | |

> **WSB usage:** `?aggregate=created_utc&frequency=hour&subreddit=wallstreetbets&query=GME&after=…&before=…`
> yields an hourly mention time-series for a ticker in one call — the backbone of the
> empirical "mention volume" signal.

---

## Subreddits

### Search

- `GET /api/subreddits/search`

> The subreddit list/data is updated **infrequently**; aggregate `_meta` data updates more often.

Examples:
- `/api/subreddits/search?subreddit_prefix=ask`
- `/api/subreddits/search?min_subscribers=1000&sort_type=created_utc&sort=asc`

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `subreddit` | `string` | — | |
| `subreddit_prefix` | `string` | — | |
| `after` | `Date` | — | Subreddit creation date |
| `before` | `Date` | — | Subreddit creation date |
| `min_subscribers` | `int` | — | |
| `max_subscribers` | `int` | — | |
| `over18` | `boolean` | — | NSFW |
| `limit` | `int` (1–1000) | `25` | |
| `sort` | `asc` \| `desc` | `desc` | |
| `sort_type` | `created_utc` \| `subscribers` \| `subreddit` | `subscribers` | |
| `fields` | `string` | — | Selectable fields |

### Rules

- `GET /api/subreddits/rules` — e.g. `/api/subreddits/rules?subreddits=askreddit,politics`

| Parameter | Type | Notes |
|---|---|---|
| `subreddits` | `string[]` | Comma-separated. **Limit: 1000** |

### Wikis

- `GET /api/subreddits/wikis` — e.g. `/api/subreddits/wikis?subreddit=askreddit`
  - or specific pages: `/api/subreddits/wikis?paths=/r/reddit.com/wiki/faq,/r/travel/wiki/faq`
- `GET /api/subreddits/wikis/list` — list all wiki page paths of a subreddit

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `paths` | `string[]` | — | Comma-separated wiki pages. **Limit: 100** |
| `subreddit` | `string` | — | Return all wiki pages of a subreddit |
| `limit` | `int` | `100` | Max 100 |

> **WSB usage:** the subreddit wiki/rules can be pulled to keep the project's list of
> banned/restricted tickers and posting rules current (WSB encodes some of this in its wiki).

---

## Users

### Search

- `GET /api/users/search`

> Aggregate data only (names, ids, post/comment counts, earliest/latest activity, karma).
> Updated infrequently; `_meta` more often. `id` may be `null` if the user has been inactive
> for recent years. (`/api/users/ids` shares these caveats.)

Examples:
- `/api/users/search?sort_type=total_karma`
- `/api/users/search?author_prefix=mod&min_num_comments=1000&sort_type=author&sort=asc`

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `author` | `string` | — | |
| `author_prefix` | `string` | — | |
| `min_num_posts` | `int` | — | |
| `min_num_comments` | `int` | — | |
| `active_since` | `Date` | — | Date of first post/comment |
| `min_karma` | `int` | — | |
| `limit` | `int` (1–1000) | `25` | |
| `sort` | `asc` \| `desc` | `desc` | |
| `sort_type` | `author` \| `total_karma` | `total_karma` | Karma = sum of post/comment scores |

### Interactions

> For very active users (especially bots), these have a high chance of **timing out** — narrow
> with `after`/`before`.

**User → user:**
- `GET /api/users/interactions/users` (aggregated counts)
- `GET /api/users/interactions/users/list` (individual interactions)

Counts as an interaction: author commented under a post; author commented under a comment;
someone replied to author's post; someone replied to author's comment.
Example: `/api/users/interactions/users?author=spez&before=2017-01-01&min_count=10`

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `author` | `string` | — | **required** |
| `subreddit` | `string` | — | |
| `after` / `before` | `Date` | — | |
| `min_count` | `int` (≥0) | — | Minimum interactions |
| `limit` | `int` (≥1) \| empty | `100` | Empty = no limit |

**User → subreddit:**
- `GET /api/users/interactions/subreddits` — which subreddits a user is active in (weighted).

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `author` | `string` | — | **required** |
| `weight_posts` | `float` | `1.0` | |
| `weight_comments` | `float` | `1.0` | |
| `after` / `before` | `Date` | — | |
| `min_count` | `int` (≥0) | — | |
| `limit` | `int` (≥1) \| empty | `100` | Empty = no limit |

### Aggregate flairs

- `GET /api/users/aggregate_flairs?author=<u>` — groups a user's `author_flair_text` values by
  subreddit. (`author` required.)

> **WSB usage:** user-history endpoints power a *credibility* dimension — e.g. is a poster a
> long-tenured WSB regular or a brand-new account? interactions/flairs help profile accounts
> behind a bullish/bearish wave (astroturf detection).

---

## Short links

- `GET /api/short_links` — resolve Reddit short links to full URLs.
  - e.g. `/api/short_links?paths=/r/running/s/3TzXiyxaMD,/u/CEO_Gola/s/WO7Ro11h1a`

| Parameter | Type | Notes |
|---|---|---|
| `paths` | `string[]` | Comma-separated, **case-sensitive**. Max: 1000 |

---

## Time series

- `GET /api/time_series` — pre-aggregated metrics over time. Data may be a few hours/days
  behind and isn't guaranteed 100% accurate.

Examples:
- `/api/time_series?key=global/posts/count&precision=year`
- `/api/time_series?key=r/askreddit/subscribers&precision=year`

| Parameter | Type | Notes |
|---|---|---|
| `key` | `string` | Series type/category (see below) |
| `precision` | `string` | `year`, `quarter`, `month`, `week`, `day`, `hour`, `minute` |
| `after` | `Date` | Start (defaults to earliest available) |
| `before` | `Date` | End (defaults to latest available) |

Available keys:
- `global/posts/count`, `global/comments/count` — Reddit-wide post/comment counts
- `global/posts/sum_score`, `global/comments/sum_score` — sum of upvotes
- `global/posts/sum_retrieved_after_seconds`, `global/comments/sum_retrieved_after_seconds` —
  sum of (archival time − creation time)
- `r/<subreddit>/posts/count`, `r/<subreddit>/comments/count`
- `r/<subreddit>/posts/sum_score`, `r/<subreddit>/comments/sum_score`
- `r/<subreddit>/subscribers`

> **WSB usage:** `key=r/wallstreetbets/comments/count&precision=day` is a free, one-call proxy
> for **overall subreddit activity** — the denominator you normalize ticker mentions against
> (so a ticker's *share of voice* isn't fooled by days when the whole sub is just busy).

---

## Data type notes

### Selectable fields

Pass `fields=` to reduce response size/latency. Available fields:

- **Both posts & comments:** `author`, `author_fullname`, `author_flair_text`, `created_utc`,
  `distinguished`, `id`, `retrieved_on`, `subreddit`, `subreddit_id`, `score`
- **Posts:** `crosspost_parent`, `link_flair_text`, `num_comments`, `over_18`, `post_hint`,
  `selftext`, `spoiler`, `title`, `url`
- **Comments:** `body`, `link_id`, `parent_id`
- **Subreddits:** `created_utc`, `description`, `public_description`, `display_name`, `id`,
  `over18`, `retrieved_on`, `subscribers`, `title` (and `_meta` fields)

### Boolean
True: `true`, `1`, `yes`, `y`. False: `false`, `0`, `no`, `n`.

### ID
Base-36 number, optionally prefixed `t3_` (post) / `t1_` (comment). The id is the part of a
Reddit permalink (`reddit.com/.../comments/<post_id>/.../<comment_id>`). Valid: `sphocx`,
`t3_sphocx`, `dppum98`, `t1_dppum98`.

### Author and subreddit
A leading `u/` or `r/` prefix is ignored.

### Date
Accepts: epoch **seconds**, epoch **milliseconds**, ISO-8601 (partial) —
`2020-01-01T00:00:00.000Z`, `2020-01-01 00:00:00`, or `2020-01-01` — **or** an offset from now
(`1year`, `3m`, `2d`, `1hour`, `5min`, `10s`).

### Full-text / keyword search
> The README flags this section as possibly out of date — search features can change.

Currently: **posts** use simple (fast) keyword search; **comments** use Postgres FTS (slow,
`websearch_to_tsquery` semantics):
- `Word1 Word2` → both words, any order
- `"Word1 Word2"` → `Word1` followed by `Word2` (words may sit between)
- `Word1 OR Word2` → either
- `Word1 -Word2` → `Word1` but not `Word2`

Reminder: keyword search requires an `author`/`subreddit` (or `link_id`/`parent_id` for
comment `body`) scope — there is **no Reddit-wide FTS** here (use PullPush for that).

---

## Operational notes

### Rate limiting
"If you're a normal user and only make a couple requests per second, you have nothing to worry
about." Heavy use may be throttled. Read response headers:
- `X-RateLimit-Remaining` — requests remaining
- `X-RateLimit-Reset` — when the window resets

Empirically (BAScraper author): hard limit is **usually ~2000 requests/minute** (varies),
`limit=auto` can return >100 results/request, and **10–20 concurrent workers hold up well** —
i.e. materially more headroom than PullPush. Response times ~1 s, or >5 s for complex large
queries. **For massive data, use the monthly dumps, not the API.**

### Query timeout
A `"Query timed out"` response usually means an unoptimized parameter combination (often
`body`/`selftext`/`title` keyword search). Mitigate: reduce `limit`, add a tighter filter
(`after`/`before`/`subreddit`/`author`), or simply retry (the DB may need to "warm up").

### Score / num_comments freshness
Until ~**36 hours** after posting, `score`, `num_comments`, etc. may be `0`/`1` (data is
archived at creation time). After ~36 h they update to match the `.zst` dump values. **Do not
trust engagement numbers on <36h-old items from this API** — re-fetch later, or pull current
values from the live Reddit API.

---

## Bulk dumps (for historical backfill)

For large/historical work, download the monthly dumps instead of hitting the API:

- **Download index:** `download_links.md` in the repo; new dumps also appear on the
  [GitHub releases page](https://github.com/ArthurHeitmann/arctic_shift/releases) (monthly
  cadence; the repo had 36 releases as of ~April 2026).
- **Single-subreddit / single-user extraction:** the
  [download-tool](https://arctic-shift.photon-reddit.com/download-tool) pulls just one
  subreddit (e.g. `wallstreetbets`) or user without grabbing terabytes — **the right path for
  a WSB-only historical backfill.**
- **Formats:** `.zst` (Zstandard), `.zst_blocks`, `.jsonl`/`.ndjson`, `.json`.
- **Processing:** clone with `--recursive`, `pip install zstandard`, then edit
  `scripts/processFiles.py` (`fileOrFolderPath` + your logic in `processFile`). Works on the
  compressed files directly — recommended over unpacking (needs Python ≥3.10). Lineage of the
  dumps traces to Watchful1 / the original Pushshift monthly archives.
- **Data semantics:** see `file_content_explanations.md` in the repo for how fields were
  collected/modified.

---

## Removals & contact
- **Removal / support form:** [Google Form](https://docs.google.com/forms/d/e/1FAIpQLSfzkmE8Bg6K_xii7aRm66ljzvo2tR59lTsdJ99acW4WX786Vw/viewform?usp=sf_link).
  Check if your data is present via the [search tool](https://arctic-shift.photon-reddit.com/search).
- **Contact:** Discord `raiderbv` / <mailto:arctic.shift.contact@gmail.com> / GitHub issues.

---

## When to use Arctic-Shift vs PullPush (summary)

| Need | Use |
|---|---|
| Mentions/volume time-series for a ticker in WSB | **Arctic-Shift** `…/aggregate` (one call) |
| Pull all posts/comments in WSB for a window | **Arctic-Shift** (`limit=auto`, more workers) |
| Historical backfill (years) | **Arctic-Shift dumps** (download-tool, single subreddit) |
| Reddit-**wide** free-text ticker search (all subs) | **PullPush** (only it does Reddit-wide FTS) |
| Cross-check / redundancy when one is down | the other (both are free, no-SLA) |

Full strategy in [`reddit-data-access.md`](./reddit-data-access.md).
