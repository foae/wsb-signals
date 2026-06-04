#!/usr/bin/env python3
"""Phase-0.2 Alpaca smoke — verify what the FREE tier actually serves, since it
gates Phase 2 (the market overlay). Tests, with the .env credentials:

  1. /v2/stocks/snapshots          multi-symbol price/volume (IEX)  → ret, rvol inputs
  2. /v1beta1/options/snapshots/X  option chain w/ Greeks + IV (feed=indicative) → H_m inputs
  3. /v1beta1/screener/stocks/...  most-actives + movers            → STEALTH market-wide scan?
  4. rate-limit headers

Reads ../.env. Stdlib only.  python3 probe_alpaca.py
"""
import json
import os
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_env(path):
    env = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def get(url, key, sec, timeout=45):
    req = urllib.request.Request(url, headers={
        "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": sec, "User-Agent": "wsb-signals-probe/0.1"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read().decode("utf-8", "replace"), (time.time() - t0) * 1000
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode("utf-8", "replace"), (time.time() - t0) * 1000
    except Exception as e:  # noqa: BLE001
        return None, {}, f"ERR {type(e).__name__}: {e}", (time.time() - t0) * 1000


def rl(hdr):
    return {k: v for k, v in hdr.items() if "ratelimit" in k.lower()}


def main():
    env = load_env(os.path.join(ROOT, ".env"))
    key, sec = env.get("ALPACA_API_KEY"), env.get("ALPACA_API_SECRET")
    data = env.get("ALPACA_DATA_URL", "https://data.alpaca.markets").rstrip("/")
    if not key or not sec:
        print("FATAL: ALPACA_API_KEY/SECRET missing from .env")
        return

    # 1) stock snapshots
    print("## 1. stock snapshots (/v2/stocks/snapshots, feed=iex)")
    st, hdr, body, ms = get(f"{data}/v2/stocks/snapshots?symbols=AVGO,SPY,MU&feed=iex", key, sec)
    print(f"   status={st} {ms:.0f}ms ratelimit={rl(hdr)}")
    if st == 200:
        d = json.loads(body)
        avgo = d.get("AVGO", {})
        print(f"   AVGO keys: {sorted(avgo.keys())}")
        lt, db = avgo.get("latestTrade", {}), avgo.get("dailyBar", {})
        print(f"   AVGO latestTrade.p={lt.get('p')} dailyBar(o/c/v)={db.get('o')}/{db.get('c')}/{db.get('v')}")
    else:
        print(f"   FAIL body[:200]={body[:200]!r}")

    # 2) options snapshots (indicative free feed)
    print("\n## 2. option chain (/v1beta1/options/snapshots/AVGO, feed=indicative)")
    st, hdr, body, ms = get(f"{data}/v1beta1/options/snapshots/AVGO?feed=indicative&limit=20", key, sec)
    print(f"   status={st} {ms:.0f}ms ratelimit={rl(hdr)}")
    if st == 200:
        d = json.loads(body)
        snaps = d.get("snapshots", {})
        print(f"   returned {len(snaps)} contracts; next_page_token={d.get('next_page_token')!r}")
        if snaps:
            sym = next(iter(snaps))
            c = snaps[sym]
            print(f"   sample {sym}: keys={sorted(c.keys())}")
            print(f"      greeks={c.get('greeks')}")
            print(f"      impliedVolatility={c.get('impliedVolatility')}")
            print(f"      latestQuote={c.get('latestQuote')}")
            print(f"      latestTrade={c.get('latestTrade')}")
    else:
        print(f"   FAIL body[:300]={body[:300]!r}")

    # 3) screeners — most-actives + movers (can we see the market-wide list? → STEALTH)
    for name, path in [("most-actives", "screener/stocks/most-actives?top=15"),
                       ("movers", "screener/stocks/movers?top=15")]:
        print(f"\n## 3. screener {name} (/v1beta1/{path.split('?')[0]})")
        st, hdr, body, ms = get(f"{data}/v1beta1/{path}", key, sec)
        print(f"   status={st} {ms:.0f}ms ratelimit={rl(hdr)}")
        if st == 200:
            d = json.loads(body)
            if name == "most-actives":
                acts = d.get("most_actives", [])
                print(f"   {len(acts)} names; sample={[a.get('symbol') for a in acts[:10]]}")
            else:
                gain = d.get("gainers", [])
                los = d.get("losers", [])
                print(f"   gainers={len(gain)} losers={len(los)}; top gainer={gain[0] if gain else None}")
        else:
            print(f"   FAIL body[:200]={body[:200]!r}")

    print("\n=== VERDICT (Phase 2 gating) ===")
    print("  Stock snapshots → ret/rvol inputs;  Options snapshots → pcr/IV/Greeks for H_m;")
    print("  Screeners working = a market-wide list → could populate STEALTH (else UNKNOWN).")


if __name__ == "__main__":
    main()
