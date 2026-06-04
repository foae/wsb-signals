# Updating these source docs

Recipes for refreshing the `sources/` references. Each external source has a fetch method that
**works** and several that **don't** — captured here so the next person/agent doesn't rediscover
it. Drift is expected (APIs, tiers, limits change); anything tagged `[verify]`/`[uncertain]` in a
doc is a known gap to confirm against the live source.

## General gotchas — pick the right fetch method

- **GitHub READMEs / repo files → `curl` the raw URL.** Verbatim, no JS:
  `https://raw.githubusercontent.com/{owner}/{repo}/{branch}/README.md` (try `master`, then
  `main`). Used for arctic-shift, BAScraper, ibeam, ibind.
- **Massive & Alpaca docs → use their Markdown / `llms.txt` mirrors, not the JS site.** Append
  `.md` to any doc URL, or read the `llms.txt` index. `curl`s clean; Alpaca's reference `.md`
  pages embed the full **OpenAPI** spec (exact paths/params/defaults).
- **Reddit → `old.reddit.com` + `firecrawl scrape`.** Plain WebFetch fails on Reddit; `about.json`
  is anti-bot-blocked (don't rely on it for subscriber counts).
- **Discord server facts → the public invite API** (ground truth; aggregator listings are stale):
  `https://discord.com/api/v9/invites/{code}?with_counts=true`.
- **Client-rendered pages (Massive pricing/KB) → a headless browser** (chrome-devtools `navigate`
  + `evaluate` `document.body.innerText`). WebFetch/firecrawl return only the page title. Note
  `evaluate` needs an expression (IIFE/bare expr), not a top-level `return`; and the Massive KB URL
  drifted `…polygons…` → `…massives…`.

## Per-source refresh table

| Doc | Canonical source | How to fetch |
|---|---|---|
| `pullpush-api.md` | <https://pullpush.io/> (docs inline on homepage) | `curl` homepage, strip HTML tags. Forum (`forum.pullpush.io`) is a JS SPA → firecrawl. Rate limits: cross-check the [BAScraper](https://github.com/maxjo020418/BAScraper) README. |
| `arctic-shift-api.md` | repo `api/README.md` | `curl https://raw.githubusercontent.com/ArthurHeitmann/arctic_shift/master/api/README.md` (+ root `README.md` for dumps). |
| `wallstreetbets.md` (subreddit) | `old.reddit.com/r/wallstreetbets/{about/rules, wiki/contentguide, wiki/linkflair, wiki/config/sidebar}` + Wikipedia | `firecrawl scrape` the `old.reddit.com/...` pages. |
| `wallstreetbets.md` (Discord) | invite codes `wsbverse`, `wallstreetbets`, `wsb` | `curl https://discord.com/api/v9/invites/{code}?with_counts=true`. Snowflake → created date (ms): `((guild_id >> 22) + 1420070400000)`. |
| `massive.md` | <https://massive.com/docs/llms.txt> + `.md` doc pages; pricing page | `curl` the `.md`/`llms.txt`; **pricing/KB via headless browser**. |
| `alpaca.md` | <https://docs.alpaca.markets/llms.txt> + `.md` mirrors (reference pages embed OpenAPI) | `curl` the `.md`/`llms.txt`. Note `…-1` slug suffix = Broker API variant, not Trading. |
| `ibkr.md` | ibeam/ibind raw READMEs + IBKR Campus CPAPI v1 docs + Web API changelog | `curl` raw READMEs; pull field-tags/limits from the IBKR **changelog** (they move — keep `[verify]` flags). |
| `reddit-data-access.md`, `market-data-access.md` | derived strategy docs | Update when the underlying provider docs above change. |

## What drifts fastest (re-check before trusting numbers)
- **Tap liveness** — run `../scripts/probe_reddit_taps.py` to re-check Arctic-Shift freshness and
  whether **PullPush** has un-frozen (it was frozen @2025-05-19 as of the 2026-06-03 probe).
- **Rate limits / pricing / tiers** — `massive.md`, `alpaca.md`, `pullpush-api.md` rate sections.
- **Discord member counts** and the **WSB subscriber figure** — snapshots; re-pull when they matter.
- **IBKR field tags & snapshot caps** — confirm against the live IBKR field reference/changelog.
