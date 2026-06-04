# Massive (formerly Polygon.io) — market-data funnel reference

> One of two documented market-data providers (the other: [`alpaca.md`](./alpaca.md)). Decision
> matrix in [`market-data-access.md`](./market-data-access.md). Compiled 2026-06-03 from Massive's
> official docs (every doc page has a `.md` mirror; index at
> <https://massive.com/docs/llms.txt>), the `massive` Python SDK, and the rendered pricing page.
> `[uncertain]` = not nailed down verbatim.

## What it is

Massive is a US market-data API (stocks, options, indices, FX/crypto, futures) — **Polygon.io,
rebranded to Massive.com on 2025-10-30.** Largely a brand/host change: existing keys, code, and
endpoint paths keep working.

- **Base URLs (both live today):** `https://api.massive.com` (new default) and
  `https://api.polygon.io` (legacy, "supported for an extended period," eventual sunset with
  notice).
- **Auth:** `?apiKey=YOUR_KEY` **or** header `Authorization: Bearer YOUR_KEY`.
- **SDK:** `pip install -U massive` → `from massive import RESTClient, WebSocketClient` (legacy
  pkg was `polygon-api-client`). Latest ~v2.8.0 (May 2026).
- **Docs trick:** append `.md` to any `https://massive.com/docs/...` URL for verbatim
  paths/params/sample-JSON; machine index at `/docs/llms.txt` and `/docs/rest/llms.txt`.

## ⚠️ Tier reality — the thing that changes the project

**The free Basic ($0) tier is End-of-Day only**, with **no Snapshot endpoints and no
WebSockets.** It **cannot drive an intraday radar.** Subscriptions are **sold separately per
asset class** (Stocks, Options, Indices…), each with its own Basic plan and its own **5 req/min**
allowance. Intraday requires **≥ Starter ($29/mo, per asset class)**.

### Stocks tiers (per <https://massive.com/pricing>)
| Tier | $/mo | API calls | Freshness | History | Snapshots / WS |
|---|---|---|---|---|---|
| Basic | 0 | **5/min** | **End-of-Day only** | 2 y | ❌ / ❌ |
| Starter | 29 | Unlimited¹ | **15-min delayed** | 5 y | ✅ / ✅ |
| Developer | 79 | Unlimited¹ | 15-min delayed **+ trades** | 10 y | ✅ |
| Advanced | 199 | Unlimited¹ | **Real-time + quotes** | 20+ y | ✅ |

### Options tiers (separate product)
| Tier | $/mo | Freshness | Notable for a radar |
|---|---|---|---|
| Basic | 0 | **End-of-Day only** | no snapshot/WS |
| Starter | 29 | prices 15-min delayed, **Greeks & IV REAL-TIME**, daily OI | **the sweet spot for an options radar** |
| Developer | 79 | + trades | |
| Advanced | 199 | **real-time** prices + quotes | |

¹ "Unlimited" paid calls are still under a soft fair-use ceiling (~100 req/s; KB:
"stay under 100 requests per second"). Over-limit → **HTTP 429**. Billing is **flat monthly
regardless of usage**; annual −20%. Business/"pro" use is priced separately.

**Bottom line:** your current key (5/min) = free Basic = **EOD only**. To use Massive for the
intraday radar you need **Stocks Starter ($29) + Options Starter ($29) = $58/mo** (15-min delayed
prices, real-time option Greeks/IV, snapshots + WS unlocked). Real-time prices = $199/asset.

## Endpoints for the radar (verbatim paths; host = `api.massive.com`)

### Stocks
| Purpose | Path | Notes |
|---|---|---|
| **Full-market snapshot** (ALL tickers, 1 req) | `GET /v2/snapshot/locale/us/markets/stocks/tickers` | 10k+ tickers in one call. `tickers=` filter, `include_otc`. **Starter+ only.** Snapshot cleared 3:30 AM ET, repopulates ~4:00 AM ET. Fields per ticker: `day/min/prevDay {o,h,l,c,v,vw}`, `lastTrade`, `lastQuote`, `todaysChangePerc`. |
| Single snapshot | `GET /v2/snapshot/locale/us/markets/stocks/tickers/{ticker}` | |
| **Gainers / losers** | `GET /v2/snapshot/locale/us/markets/stocks/{gainers\|losers}` | top 20, min vol 10k. Radar-native. Starter+. |
| Unified multi snapshot (≤250) | `GET /v3/snapshot?ticker.any_of=...&type=stocks` | can mix stocks/options/indices; 250 cap. |
| Custom bars | `GET /v2/aggs/ticker/{ticker}/range/{mult}/{timespan}/{from}/{to}` | `adjusted`, `sort`, `limit`≤50000. ET. |
| **Grouped daily** (whole market, 1 date) | `GET /v2/aggs/grouped/locale/us/market/stocks/{date}` | **"included across all pricing plans"** → the one bulk stock endpoint usable on **free** (EOD). |
| Reference tickers (symbol whitelist) | `GET /v3/reference/tickers` | cursor pagination; `active`, `type`, `market`, `search`. |

### Options (the strong suit)
| Purpose | Path | Notes |
|---|---|---|
| **Option chain snapshot** (all contracts) | `GET /v3/snapshot/options/{underlyingAsset}` | **Returns `greeks{delta,gamma,theta,vega}`, `implied_volatility`, `open_interest`, `day{volume,…}`, `last_quote/last_trade` — server-side, not computed by you.** `limit` default 10, **max 250** → paginate/filter by `expiration_date`/`strike_price` for a full chain. |
| Single contract snapshot | `GET /v3/snapshot/options/{underlyingAsset}/{optionContract}` | |
| Option bars | `GET /v2/aggs/ticker/{O:OCC}/range/{mult}/{timespan}/{from}/{to}` | OCC id, e.g. `O:AAPL230616C00150000`. |
| Contracts reference | `GET /v3/reference/options/contracts?underlying_ticker=...` | discover strikes/expiries. |

OCC id format: `O:` + underlying + `YYMMDD` + `C/P` + strike×1000 (8 digits) →
`O:SPY241220P00720000`.

### Indices (context: SPX/NDX/VIX)
| Purpose | Path | Notes |
|---|---|---|
| Indices snapshot | `GET /v3/snapshot/indices?ticker.any_of=I:VIX,I:SPX,I:NDX` | current level in `value`. `I:` prefix. |
| Indices bars | `GET /v2/aggs/ticker/{I:TICKER}/range/{mult}/{timespan}/{from}/{to}` | **no `v`/`vw`** (indices have no volume). |

> SPY/QQQ are ETFs → use the **stocks** endpoints (`SPY`, `QQQ`). `I:SPX`/`I:NDX` are the index
> levels. `[uncertain]` real-time `I:VIX` may need a paid Indices tier (Cboe-sourced).

## Rate limits
- **Basic (free): 5 req/min, per asset class** (separate Stocks/Options/Indices Basic plans, each
  with its own 5/min). `[uncertain]` exact per-key vs per-entitlement enforcement — structure
  implies separate buckets.
- **Paid: "unlimited"** under a ~100 req/s soft fair-use ceiling. 429 on breach.

## Official MCP server
- Repo: <https://github.com/massive-com/mcp_massive> (ex `polygon-io/mcp_polygon`; experimental).
- Three composable tools: **`search_endpoints`** (NL search over the API), **`call_api`** (call any
  REST endpoint; can store results into in-memory SQLite via `store_as`), **`query_data`** (SQL
  over stored data). Plus **built-in financial functions**: `bs_price/bs_delta/bs_gamma/bs_theta/
  bs_vega/bs_rho` (Black-Scholes — incl. `rho`, which the REST snapshot omits), returns,
  Sharpe/Sortino, SMA/EMA. Self-indexes from `llms.txt`.
- Install: `uv tool install "mcp_massive @ git+https://github.com/massive-com/mcp_massive@v0.10.0"`
  then `claude mcp add massive -e MASSIVE_API_KEY=... -- mcp_massive` (Python 3.12+, UV ≥0.4).
  Env: `MASSIVE_API_KEY` (req), `MASSIVE_API_BASE_URL` (default `api.massive.com`), `MCP_TRANSPORT`.

## What this means for WSB Signals
- **Strong suit = options.** Options Starter ($29) gives **real-time Greeks/IV + daily OI**, and
  the chain snapshot returns them server-side — ideal for the "options matrix breadth" signal.
- **Unique efficiency = the full-market snapshot** (1 req → entire market) — perfect for the
  radar's stock overlay, but **Starter+ only** (free Basic can't snapshot).
- **Free Basic is EOD-only** → on the current free key, the market side is a **daily** overlay at
  best. For intraday you either pay $29/asset here, or prototype on **Alpaca's free real-time IEX**
  ([`alpaca.md`](./alpaca.md)) and accept thin volume. See
  [`market-data-access.md`](./market-data-access.md).

## Uncertainties
- Per-key vs per-entitlement 5/min enforcement `[uncertain]`.
- Free vs paid real-time `I:VIX` `[uncertain]`.
- Whether delayed-tier WebSocket is a true (delayed) stream or polled `[uncertain]`.
