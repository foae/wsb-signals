# IBKR (Interactive Brokers) — market-data funnel reference

> Third documented market-data provider (others: [`alpaca.md`](./alpaca.md),
> [`massive.md`](./massive.md)); decision matrix in
> [`market-data-access.md`](./market-data-access.md). Covers the **Client Portal Web API** plus the
> two open-source tools that make it usable headless — **ibind** (client) and **ibeam** (auth
> daemon). Compiled 2026-06-03 from the ibeam/ibind READMEs and IBKR Campus docs. `[verify]` flags
> things to confirm against IBKR's live field/limit reference (these change).

## What it is

Interactive Brokers exposes the **Client Portal Web API** (a.k.a. **Web API 1.0 / CPAPI 1.0**) —
REST + WebSocket over a session you authenticate as a real IBKR user. It's **institutional-grade**
(real-time full-volume quotes, complete options chains with Greeks/IV, futures, indices incl. VIX)
**if** you have the data subscriptions. It is also the **heaviest** integration of the three
providers. Key constraints up front:

- **IBKR Pro account only** (not Lite), **funded**, with **market-data subscriptions purchased**
  for real-time data (delayed data works without). Subscriptions are per-exchange (e.g. US
  Securities Snapshot bundle; **OPRA** for options) and are often waived above a monthly commission
  threshold `[verify pricing]`.
- **Session-based, not an API key.** A brokerage session **times out after 5 min** without
  activity → you must call **`/tickle` ~every minute** to keep it alive.
- **Everything is keyed by `conid`** (IB contract id). You resolve symbols → conids before any
  market data.
- **No "whole-market" snapshot.** You snapshot a *watchlist* of conids → fits our model of gating
  market data to the **hot leaderboard**, but it's not a market scanner.

Base URL: via the local gateway `https://localhost:5000/v1/api/...`, or IBKR-hosted (OAuth)
`https://api.ibkr.com/v1/api/...`. Docs: <https://ibkrcampus.com/ibkr-api-page/cpapi-v1/>.

## The two open-source tools (this is why IBKR is tractable)

### ibind — the Python client (<https://github.com/Voyz/ibind>)
Unofficial Python client for the CP Web API 1.0 (REST + WebSocket). What it gives us:
- **`IbkrClient`** (REST) and **`IbkrWsClient`** (WebSocket; subscription-based, thread + queue
  model with lifecycle/health handling).
- **Fully headless auth via OAuth 1.0a** — *no gateway process needed* (the modern path), **or**
  point it at an ibeam-run gateway.
- Built-ins that remove real work: **rate limiting**, **conid unpacking** (symbol→conid),
  **automated question/answer handling** (order confirmations), **parallel requests**.
- `pip install ibind`. Config via env (`IBIND_ACCOUNT_ID`, `IBIND_CACERT`, OAuth creds).
- Beta; Apache-2.0; not affiliated with IBKR.

### ibeam — the auth/session daemon (<https://github.com/Voyz/ibeam>)
Authentication + maintenance tool for the **CP Web API Gateway**. What it does:
- Runs the Gateway **headless** (virtual display, no physical screen), **auto-injects IBKR
  credentials** into the login page via Selenium/Chrome, then **keeps the session alive** (tickle)
  and **re-logs in** on session loss.
- **Two-factor auth** + TLS cert support. Plug-and-play **Docker** image (`voyz/ibeam`), exposes
  the gateway on **port 5000**.
- ⚠️ **Security:** it must **store your IBKR credentials** (env vars / Docker secrets / GCP Secret
  Manager) → a real risk. **Use Paper Account credentials** where possible. `restart: 'no'` in
  compose to avoid lockout from `IBEAM_MAX_FAILED_AUTH`.
- It is **not** for TWS/IB Gateway (use IBC for that) — only the Client Portal Web API Gateway.

### Two ways to connect (pick one)
- **A. ibind + OAuth 1.0a (recommended, fully headless):** no gateway, no Selenium, no port 5000.
  Cleanest for an automated pipeline; just credentials/keys in ibind.
- **B. ibeam (Docker gateway) + ibind/REST → `https://localhost:5000/v1/api`:** the classic setup;
  ibeam handles login/keepalive, ibind (or raw HTTP) calls the gateway. Heavier (a browser + Java
  gateway running) but well-trodden.

## Market-data endpoints for the radar

> Use ibind's methods rather than hand-rolling these; the raw paths are shown for reference.

### Snapshot (top-of-book) — the workhorse
`GET /iserver/marketdata/snapshot?conids={csv}&fields={csv}`
- ⚠️ **Two-request "pre-flight" pattern:** the **first** call for a conid *initializes the stream
  and returns no data*; call again to get values. Include **all** desired field tags on that first
  call. Snapshot data is pulled from open streams, not cached.
- **Limits: 100 conids/query, max 50 fields** `[verify — from changelog]`.
- Some fields (Greeks, IV) **take seconds–minutes to populate**, especially on illiquid strikes.
- **Field tags** are numeric. Confirmed/likely useful (verify the full set against IBKR's field
  reference):

  | Tag | Field | |
  |---|---|---|
  | `31` | Last price | ✅ confirmed |
  | `84` / `86` | Bid / Ask | ✅ |
  | `85` / `88` | Ask size / Bid size | ✅ |
  | `87` | Volume (formatted) | `[verify]` |
  | `7059` | Last size | `[verify]` |
  | `7283` | Implied Volatility % | `[verify]` |
  | `7308`/`7309`/`7310`/`7311` | Delta / Gamma / Theta / Vega | `7310`=Theta ✅; rest `[verify]` |
  | `7295`/`7296` | Open / Close | `[verify]` |

### Historical bars
`GET /iserver/marketdata/history?conid={id}&period=...&bar=...` — **max 5 concurrent requests.**
(Also `hmds/history` for the historical market-data service.) Use for baselines (rvol, realized
vol).

### Options chain — strict sequential workflow (no shortcut)
1. `GET /iserver/secdef/search?symbol={SYM}` → underlying **conid** (call this first for
   derivatives).
2. *(optional)* snapshot the underlying's last price (field `31`) to gauge moneyness.
3. `GET /iserver/secdef/strikes?conid={underlying}&secType=OPT&month={MON}` → available strikes.
4. `GET /iserver/secdef/info?conid={underlying}&month={MON}&strike={K}&secType=OPT&right={C|P}` →
   resolves the specific option **conids** (multiple expiries per month).
5. `GET /iserver/marketdata/snapshot` on those option conids (Greeks/IV via the field tags above).
- **Optimization:** build a **conid/contract library ahead of time** and reuse it; don't re-walk
  the chain every cycle.

### Streaming (WebSocket) + session
- WebSocket `wss://.../v1/api/ws` with `smd+{conid}` market-data subscriptions (push quotes/Greeks)
  — ibind's `IbkrWsClient` manages subscriptions/queues. Good alternative to repeated snapshots for
  the hot watchlist.
- `GET /iserver/marketdata/{conid}/unsubscribe` to drop a stream. **`/tickle` ~every 60 s** to keep
  the session alive (ibeam automates this).
- General **pacing limits** apply across CP API endpoints (~10 req/s order-of-magnitude) `[verify]`.

## What this means for WSB Signals
- **Best data quality** of the three — real-time **full-volume** prices (no IEX-thin problem) and
  complete options chains with Greeks/IV — *if* you already run an **IBKR Pro** account with the
  needed subscriptions. The radar's `rvol` would be trustworthy here.
- **Highest operational cost:** session keepalive, conid resolution, pre-flight snapshots, and the
  sequential options workflow. **ibind + OAuth 1.0a** (or **ibeam** for the gateway) absorb most of
  that pain — which is exactly why these two tools matter.
- **Fits the gating model:** because IBKR snapshots a *watchlist*, resolve conids for the **top-N
  hot tickers** from `H_e` and snapshot/stream only those. Not a market scanner — but the radar
  already discovers tickers from Reddit, so that's fine.
- **Recommendation:** keep IBKR as the **"production-grade, already-have-an-account"** funnel impl
  behind the same `MarketData` interface; prototype on free Alpaca, and switch/mix to IBKR (or
  paid Alpaca/Massive SIP) when volume fidelity matters. See
  [`market-data-access.md`](./market-data-access.md).

## Uncertainties / to verify
- Exact field-tag numbers beyond the confirmed ones (`31`, `84/85/86/88`, `7310`) `[verify]`.
- Current snapshot caps (100 conids/50 fields) and global pacing (~10 req/s) `[verify — changelog]`.
- Market-data subscription costs and commission-waiver thresholds `[verify]`.
- Whether the newer "Web API" (CPAPI 2.0) is worth waiting for — ibind supports **1.0** only for
  now (2.0 still beta/undocumented).
