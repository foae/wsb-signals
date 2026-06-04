# Market-data access strategy

> The market-side twin of [`reddit-data-access.md`](./reddit-data-access.md). Market data sits
> behind a `MarketData` **funnel** interface so providers are pluggable and mix-&-matchable. Three
> documented providers: [`alpaca.md`](./alpaca.md), [`massive.md`](./massive.md) (Polygon), and
> [`ibkr.md`](./ibkr.md) (Interactive Brokers). This doc picks one for v0.0.1 and records the
> upgrade path. Compiled 2026-06-03.

## The funnel interface

```
MarketData = {
  snapshot(tickers)          # price/volume now
  bars(ticker, tf, range)    # history for baselines (rvol, realized_vol)
  option_chain(underlying)   # contracts + Greeks + IV + OI  → breadth, pcr
  movers() / most_active()   # radar-native shortcuts (provider/tier dependent)
  reference_tickers()        # symbol whitelist
}
```

Alpaca, Massive, and IBKR are implementations. You can **route different methods to different
providers** (e.g. Alpaca for real-time stock snapshots, Massive for the full-market snapshot or
options once paid, IBKR for full-volume data if you already have an account). Don't hardcode a
provider.

## TL;DR decision

- **v0.0.1: Alpaca (settled 2026-06-03).** The **only free tier that does intraday** — real-time
  **IEX** stock prices + **indicative options with Greeks/IV**, 200 calls/min, WebSocket. (Massive
  free is **EOD-only**; Massive/IBKR stay documented behind the funnel for later.)
- **Known limitation: volume is thin on free.** Alpaca IEX ≈ **2.5%** of US volume → **`rvol` and
  any volume signal are low-confidence** until a paid **SIP** feed.
- **Production upgrade: a paid SIP feed.** Alpaca **Algo Trader Plus ($99/mo)** (SIP + OPRA +
  10k/min) *or* Massive **Starter ($29 stocks + $29 options)** (15-min-delayed prices, **real-time
  option Greeks/IV**, the full-market snapshot). Mix & match via the funnel.
- **Already on IBKR Pro?** [`ibkr.md`](./ibkr.md) is the **highest-fidelity** funnel —
  institutional real-time **full-volume** data + complete options chains — at the cost of the
  heaviest integration (session/conids), eased by **ibind** (headless OAuth) / **ibeam** (gateway).

## Comparison matrix

| Dimension | **Alpaca** | **Massive (Polygon)** | **IBKR** |
|---|---|---|---|
| Free intraday? | ✅ real-time IEX + indicative options | ❌ **EOD only** on free | delayed free; real-time needs **data subs** |
| Free volume coverage | IEX ~2.5% (thin) | — (EOD) | **full** (real exchange volume) |
| Real-time full-market volume | SIP @ **$99** | SIP @ $199 / 15-min @ $29 | ✅ with subs (Pro acct) |
| Options Greeks/IV at | **free** (indicative, 15-min) | **$29 Starter** (real-time) | with OPRA sub (field tags; slow to populate) |
| Full-market snapshot (1 call → all) | ❌ (symbol lists) | ✅ (Starter+) | ❌ (conid **watchlist**, 100/req) |
| Gainers / most-active | screeners (SIP-gated) `[uncertain]` | gainers/losers (Starter+) | scanner endpoint `[verify]` |
| Rate limit | 200/min → 10k/min ($99) | 5/min (EOD) → "unlimited" | ~10 req/s; 100 conids/snap, 5 concurrent history |
| Auth model | API key/secret | API key | **session** (Pro acct; tickle keepalive) |
| WebSocket | ✅ (**1-connection** limit!) | Starter+ | ✅ (smd subscriptions) |
| Index / VIX | ❌ (SPY/QQQ proxies) | ✅ `I:VIX`/`I:SPX` (maybe paid) | ✅ (real conids) |
| MCP server | ✅ local | ✅ local (NL+SQL+BS fns) | ❌ (use **ibind**) |
| Cost / prereq | **$0** | $0 EOD / **$58+** intraday | funded **IBKR Pro** + data subs |
| Integration effort | low | low | **high** (eased by ibind/ibeam) |

## Recommendation & path

1. **Build v0.0.1 on Alpaca free** — real-time IEX stock snapshots + indicative option chains
   (Greeks/IV). Compute `rvol` but **flag it low-confidence**. Use **SPY/QQQ** as market context
   (no index feed on free).
2. **When volume accuracy matters**, either upgrade to **Alpaca Algo Trader Plus ($99)** for SIP
   (single-provider simplicity) **or** add **Massive Starter ($29/cat)** for the full-market
   snapshot + real-time option Greeks and route those methods to Massive (mix & match). Pull
   **VIX** from Massive.
3. **If you already run an IBKR Pro account** with market-data subscriptions,
   [`ibkr.md`](./ibkr.md) is the **highest-fidelity** funnel (real full-volume + complete option
   chains). Wire it via **ibind** (headless OAuth 1.0a) or **ibeam** (Docker gateway). Heaviest
   integration; best data; the watchlist/conid model fits hot-list gating.
4. The funnel keeps the choice reversible.

## Caveats that touch the signals
- **`rvol` / volume** ([signal-framework §3.2](../design/signal-framework.md)) is **only as good
  as the feed** — degraded on free IEX/EOD, reliable on SIP. Flag confidence accordingly.
- **Options "matrix breadth"** needs the chain: free Alpaca gives it (indicative, delayed);
  Massive paid gives real-time Greeks/IV.
- **Alpaca's 1-WebSocket-connection** limit → one multiplexed stream.
- **As-of tagging:** stamp every market datum with its true feed time (free Alpaca real-time IEX;
  paid SIP real-time; Massive 15-min delayed) — never align a live mention spike with stale prices.
