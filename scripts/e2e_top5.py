#!/usr/bin/env python3
"""End-to-end slice: top-N tickers mentioned on r/wallstreetbets in the past
WINDOW (default 1h) via Arctic-Shift, then Alpaca price+volume for each.

Pipeline: pull posts+comments (Arctic-Shift, paginated) -> extract $TICKER /
bare-uppercase candidates -> drop a WSB/English stoplist -> rank by mentions ->
validate + price the top few via Alpaca /v2/stocks/snapshots (free IEX feed).

NOTE: this is a SMOKE TEST. It ranks by RAW mention count for simplicity — the real
framework ranks on share-of-voice with a baseline-gated z-score and never on raw counts
(see ../design/signal-framework.md §4). Don't treat this leaderboard as the product signal.

Reads credentials from ../.env. Stdlib only.  python3 e2e_top5.py
"""
import collections
import json
import os
import re
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # wsb-signals/
WINDOW = 3600          # seconds (1h)
TOP_DISPLAY = 5
CAND_PROBE = 10        # how many top candidates to send to Alpaca
MAX_PAGES = 60         # pagination safety cap (x100 items)


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


def get(url, headers=None, timeout=60):
    h = {"User-Agent": "wsb-signals-e2e/0.1"}
    if headers:
        h.update(headers)
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return None, f"ERR {type(e).__name__}: {e}"


# Tokens that look like tickers but almost never are, on WSB.
STOP = set("""
AI EV AH PM AM CC MM BN US UK EU USD EUR GBP JPY GDP CPI PPI FED FOMC ECB SEC IRS DOJ FTC
DD YOLO FD FDS IMO IMHO TLDR WSB CEO CFO CTO COO IPO ETF ETFS NFT SPAC EPS PE PT EOD EOW EOY
ATH ATL IV OI OTM ITM ATM TA FA YTD QOQ YOY FOMO FUD HODL MOON GUH BTFD BTD DCA RSI MACD VWAP
SMA EMA ROI ROIC AUM MM BPS YOLO LFG WAGMI NGMI APE APES BAG BAGS DIP RIP GG EZ OG TLDR LOL
LMAO LMFAO ROFL WTF OMG IDK IDC FYI AKA IIRC NSFW OP EDIT TYSM IMUS
ALL AND ANY ARE FOR NOT THE YOU YOUR YALL WAS HAS HAD CAN CANT GET GOT BIG TOP LOW OLD NEW NOW
ONE TWO OUT OFF OUR HIS HER WHO WHY HOW WHAT WHEN WHERE WERE THIS THAT THEY THEM THEN THAN WITH
FROM HAVE HAVENT WILL WONT WOULD JUST LIKE MORE MOST SOME SUCH OVER ONLY ALSO BEEN BUY SELL HOLD
SOLD LONG SHORT RED MAX MIN YES YEAH NAH OK OKAY DONT ISNT IM IVE ID ILL WE ME MY HE AS AN AT BY
DO IF IN IS IT OF ON OR TO UP SO BE GO NO US WAY GUY MAN LOL HUGE GAIN LOSS CALL CALLS PUT PUTS
BULL BEAR PUMP DUMP CASH BANK RICH BROKE TENDIES STONK STONKS LMAYO REGARD REGARDS GAY RETARD
""".split())

CAND = re.compile(r"(?<![A-Za-z0-9])(\$)?([A-Z]{2,5})(?![A-Za-z0-9])")
BOTS = {"AutoModerator", "VisualMod", "wsbapp", "OPStockBot"}


def extract(text):
    if not text:
        return []
    out = []
    for m in CAND.finditer(text):
        cash, sym = m.group(1), m.group(2)
        if sym in STOP and not cash:   # a $-prefix overrides the stoplist
            continue
        if sym in STOP and cash:
            pass
        out.append(sym)
    return out


def fetch_arctic(kind, cutoff, now):
    AS = "https://arctic-shift.photon-reddit.com/api"
    items, before, capped = [], now + 5, False
    for _ in range(MAX_PAGES):
        url = f"{AS}/{kind}/search?subreddit=wallstreetbets&limit=100&sort=desc&after={cutoff}&before={before}"
        st, body = get(url)
        if st != 200:
            print(f"   [warn] {kind} page failed: status={st} {body[:140]}")
            break
        data = json.loads(body).get("data", [])
        if not data:
            break
        items += data
        oldest = min(x.get("created_utc", now) for x in data)
        if oldest <= cutoff or len(data) < 100:   # reached window start, or data exhausted
            break
        before = oldest
        time.sleep(0.3)
    else:                                          # loop ran all MAX_PAGES without breaking → truncated
        capped = True
    in_window = [x for x in items if x.get("created_utc", 0) >= cutoff]
    if capped and in_window:
        covered = (now - min(x.get("created_utc", now) for x in in_window)) / 60
        print(f"   [CAP] {kind}: hit the {MAX_PAGES}-page cap ({len(in_window)} items) — only covered the most "
              f"recent ~{covered:.0f} min of the {WINDOW // 60}-min window. Counts undercount; raise MAX_PAGES.")
    return in_window


def main():
    env = load_env(os.path.join(ROOT, ".env"))
    key, sec = env.get("ALPACA_API_KEY"), env.get("ALPACA_API_SECRET")
    data_url = env.get("ALPACA_DATA_URL", "https://data.alpaca.markets").rstrip("/")
    if not key or not sec:
        print("FATAL: ALPACA_API_KEY / ALPACA_API_SECRET missing from .env")
        return
    now = int(time.time())
    cutoff = now - WINDOW
    print(f"=== WSB Signals e2e — r/wallstreetbets, last {WINDOW//60} min ===")
    print(f"window: {time.strftime('%H:%M', time.gmtime(cutoff))}–{time.strftime('%H:%M UTC', time.gmtime(now))}\n")

    # 1) Reddit
    print("[1] Pulling Reddit (Arctic-Shift)…")
    posts = fetch_arctic("posts", cutoff, now)
    comments = fetch_arctic("comments", cutoff, now)
    print(f"    scanned {len(posts)} posts + {len(comments)} comments in the window")

    mentions = collections.Counter()
    authors = collections.defaultdict(set)
    for p in posts:
        if p.get("author") in BOTS:
            continue
        for sym in set(extract(f"{p.get('title','')} {p.get('selftext','')}")):
            mentions[sym] += 1
            authors[sym].add(p.get("author"))
    for c in comments:
        if c.get("author") in BOTS:
            continue
        a = c.get("author")
        for sym in extract(c.get("body", "")):
            mentions[sym] += 1
            authors[sym].add(a)

    if not mentions:
        print("    no ticker candidates found in window (quiet hour?). Try a wider WINDOW.")
        return

    ranked = sorted(mentions.items(), key=lambda kv: (-kv[1], -len(authors[kv[0]]), kv[0]))
    print("\n    top mention candidates (post-stoplist):")
    for sym, n in ranked[:12]:
        print(f"      {sym:<6} mentions={n:<4} authors={len(authors[sym])}")

    probe = [s for s, _ in ranked[:CAND_PROBE]]

    # 2) Alpaca snapshots (price + volume), free IEX feed
    print(f"\n[2] Alpaca snapshots (IEX) for top {len(probe)} candidates…")
    url = f"{data_url}/v2/stocks/snapshots?symbols={','.join(probe)}&feed=iex"
    st, body = get(url, headers={"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": sec})
    if st != 200:
        print(f"    Alpaca error status={st}: {body[:300]}")
        return
    snaps = json.loads(body)

    # keep candidates Alpaca priced, preserve mention rank, take top N
    rows = []
    for sym, n in ranked:
        s = snaps.get(sym)
        lt = (s or {}).get("latestTrade") or {}
        db = (s or {}).get("dailyBar") or {}
        if lt.get("p") is None:
            continue
        rows.append((sym, n, len(authors[sym]), lt.get("p"), db.get("v"), db.get("o")))
        if len(rows) >= TOP_DISPLAY:
            break

    print(f"\n=== TOP {len(rows)} WSB TICKERS  +  ALPACA PRICE/VOLUME (last {WINDOW//60} min) ===")
    print(f"{'#':<2} {'ticker':<7}{'mentions':<9}{'authors':<8}{'price($)':<11}{'vol (IEX, today)':<18}{'day O→last':<14}")
    for i, (sym, n, au, p, v, o) in enumerate(rows, 1):
        vols = f"{v:,}" if isinstance(v, (int, float)) else "n/a"
        chg = f"{o}→{p}" if o else "—"
        print(f"{i:<2} {sym:<7}{n:<9}{au:<8}{p:<11}{vols:<18}{chg:<14}")
    print("\nnote: free Alpaca = real-time IEX (~2.5% of volume) → 'vol' is IEX-only, not full market.")
    print("      day volume is small right after the open; price is IEX last trade.")


if __name__ == "__main__":
    main()
