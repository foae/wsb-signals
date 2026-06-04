# Alpaca — market-data funnel reference

> The second documented market-data provider (other: [`massive.md`](./massive.md)); decision
> matrix in [`market-data-access.md`](./market-data-access.md). Compiled 2026-06-03 from official
> docs (`docs.alpaca.markets`; every page has a `.md` mirror, full index at
> <https://docs.alpaca.markets/llms.txt>), the MCP repo, and Alpaca support. `[uncertain]` flags.

## What it is

Alpaca is a US broker with a bundled **market-data API** (stocks/ETFs, options, crypto + news).
A **free paper account** is enough to pull market data — the same key/secret authenticate trading
and data.

- **Data base URL:** `https://data.alpaca.markets` (sandbox: `…sandbox…`). Stream:
  `wss://stream.data.alpaca.markets/{version}/{feed}`.
- **Auth:** headers `APCA-API-KEY-ID` + `APCA-API-SECRET-KEY`. (Data entitlement follows your
  *account's* plan, not paper-vs-live.)
- **MCP env names differ:** `ALPACA_API_KEY` / `ALPACA_SECRET_KEY` (see MCP section).
- **Rate-limit headers:** `X-RateLimit-Limit/Remaining/Reset`; `X-Request-ID` on every response.

## ⚠️ Tier reality — IEX vs SIP is the whole story

The free plan is **real-time but on the IEX feed only (~2.5% of US volume)**; full-market **SIP**
(100% volume) needs **Algo Trader Plus ($99/mo)**. A documented AAPL daily bar showed IEX volume
≈ 923k vs SIP ≈ 51.9M — **~56× difference**. ⇒ **On free Alpaca, volume signals (RVOL) see a thin
slice and are unreliable** — fine for plumbing, misleading for "is the market really reacting?".

### Equities
| | Basic (Free) | Algo Trader Plus ($99/mo) |
|---|---|---|
| Real-time coverage | **IEX** (~2.5% vol) | **All US exchanges (SIP)** |
| Historical API calls | **200/min** (per account) | 10,000/min |
| WebSocket symbol subs | **30** | Unlimited |
| Historical recency limit | **latest 15 min withheld** | none |
| History depth | since 2016 | since 2016 |

### Options
| | Basic (Free) | Algo Trader Plus |
|---|---|---|
| Feed | **Indicative** (derived, **trades 15-min delayed**) | **OPRA** (real-time) |
| Greeks + IV | ✅ included (server-side Black-Scholes) | ✅ |
| WebSocket quote subs | 200 | 1000 |
| History | since **Feb 2024** | since Feb 2024 |

`feed` param: stocks `iex\|sip\|delayed_sip\|otc\|boats`; options `indicative\|opra` (default =
best your plan allows). Over-limit → **HTTP 429**. Free `feed=sip` on *latest* endpoints →
`subscription does not permit querying recent SIP data`; on *historical* it's allowed only if
`end` ≥ 15 min ago.

## Endpoints for the radar (host = `data.alpaca.markets`)

### Stocks
| Purpose | Path | Notes |
|---|---|---|
| **Snapshots (multi)** | `GET /v2/stocks/snapshots?symbols=...` | per symbol: `latestTrade/latestQuote/minuteBar/dailyBar/prevDailyBar` — one call = price+spread+today OHLCV+prior close. Radar workhorse. |
| Bars (multi) | `GET /v2/stocks/bars?symbols=...&timeframe=1Min` | `limit`≤10000, `feed`, `adjustment`, `sort`. |
| Latest trade/quote/bar | `GET /v2/stocks/{trades\|quotes\|bars}/latest?symbols=...` | |
| **Most active** | `GET /v1beta1/screener/stocks/most-actives?by=volume&top=100` | radar-native — **but computed on real-time SIP** → likely **Algo Trader Plus only** `[uncertain free access]`. |
| **Movers** | `GET /v1beta1/screener/{stocks\|crypto}/movers?top=50` | gainers+losers; also **SIP-based** `[uncertain free]`. |

### Options (under `/v1beta1/options/...`)
| Purpose | Path | Notes |
|---|---|---|
| **Chain snapshot** | `GET /v1beta1/options/snapshots/{underlying}` | per contract: `latestTrade/Quote`, **`greeks{delta,gamma,theta,vega,rho}`, `impliedVolatility`**, bars. Filter `type/strike_price_gte/lte/expiration_date`. `limit`≤1000. |
| Snapshots (by contract) | `GET /v1beta1/options/snapshots?symbols=...` | ≤100 contract symbols. |
| Option bars / trades | `GET /v1beta1/options/{bars\|trades}` | since Feb 2024. |
| **Contracts (discovery + OI)** | `GET /v2/options/contracts` **on `api.alpaca.markets`/`paper-api…`** | ⚠️ on the **Trading** host, APCA headers. Has `open_interest`, `strike_price`, `expiration_date`. (`/v1/options/contracts` on `broker-api…` is the Broker variant — not for personal accounts.) |

> Note Alpaca's `rho` in Greeks (Massive's REST chain omits `rho`). OI lives on the contracts
> endpoint, not the snapshot.

### WebSocket (real-time)
- Stocks: `wss://…/v2/{iex\|sip\|delayed_sip}`; channels `trades,quotes,bars,dailyBars,updatedBars`;
  `*` wildcard ok for stocks. Free = `v2/iex`, **30-symbol** cap.
- Options: `wss://…/v1beta1/{indicative\|opra}`; **msgpack only**; channels `trades,quotes`
  (**no `bars`**, no `*` wildcard for quotes).
- ⚠️ **Connection limit = 1, even on Algo Trader Plus.** A second concurrent socket (incl. a 3rd-
  party app on the same key) → error 406. **Design around one multiplexed connection.**
- Test stream: `wss://…/v2/test`, symbol `FAKEPACA`.

## Official MCP server (<https://alpaca.markets/mcp-server>)
- Repo: <https://github.com/alpacahq/alpaca-mcp-server> (v2.x = FastMCP-from-OpenAPI rewrite).
  **Local, self-hosted** (no Alpaca-hosted endpoint): `uvx alpaca-mcp-server` (Python 3.10+, `uv`)
  or Docker; transport stdio (or `--transport streamable-http`).
- **Wraps trading AND market data.** Radar-relevant tools: `get_stock_snapshot`, `get_stock_bars`,
  **`get_most_active_stocks`**, **`get_market_movers`**, **`get_option_chain`**,
  **`get_option_snapshot`** (Greeks+IV), `get_option_contracts`, `get_news`,
  `get_corporate_actions`.
- **Scope it:** `ALPACA_TOOLSETS=stock-data,options-data,assets,news` exposes data tools only and
  removes order-placement tools (safety). Auth env: `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`,
  `ALPACA_PAPER_TRADE` (default true).
- ⚠️ It's **REST polling**, not a live stream — an agent's on-demand "what's moving now" hands, not
  a streaming pipeline. Inherits your account's Basic/Plus entitlement (IEX/indicative on free).

## What this means for WSB Signals
- **Best *free* intraday option.** Unlike Massive's EOD-only free tier, free Alpaca gives
  **real-time IEX prices + indicative options with Greeks/IV** + WebSocket — enough to build and
  run the radar's market side end-to-end at $0.
- **The catch is volume.** IEX ≈ 2.5% of volume → **`rvol` and any volume-based signal are
  unreliable on free** until you move to SIP ($99 Algo Trader Plus). Price/Greeks/IV are usable;
  raw volume is not.
- **One-WebSocket-connection** limit shapes the streaming design.
- **MCP server** is a nice agent-facing layer, but for the pipeline use the REST/WS API directly.

## Uncertainties
- Free-tier availability of the `most-actives`/`movers` screeners (documented as SIP) `[uncertain]`.
- 200/min "per account" vs per-key exact semantics `[uncertain]`.
- A possible legacy "$9 / 1000-calls" tier — not on the current pricing tables; treat as stale.
