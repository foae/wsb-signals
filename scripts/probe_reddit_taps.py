#!/usr/bin/env python3
"""Probe the two Reddit archive taps (PullPush, Arctic-Shift) for WSB Signals.

Checks, for r/wallstreetbets, whether each tap: (1) is reachable from here,
(2) returns recent posts/comments, (3) how fresh the newest item is — a proxy
for content-ingestion latency, the Phase-0.1 "is it live enough?" gate — and
(4) whether scores look archived-at-creation (0/1) on fresh items. Stdlib only.

Re-run at different times of day; latency varies with sub activity.
    python3 probe_reddit_taps.py
"""
import json
import time
import urllib.error
import urllib.request

SUB = "wallstreetbets"
N = 25
NOW = int(time.time())
UA = {"User-Agent": "wsb-signals-probe/0.1 (research; contact: contributors@example.invalid)"}

PP = "https://api.pullpush.io/reddit"
AS = "https://arctic-shift.photon-reddit.com/api"


def get(url, timeout=45):
    t0 = time.time()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
            return r.status, dict(r.headers), r.read().decode("utf-8", "replace"), (time.time() - t0) * 1000
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode("utf-8", "replace"), (time.time() - t0) * 1000
    except Exception as e:  # noqa: BLE001
        return None, {}, f"ERR {type(e).__name__}: {e}", (time.time() - t0) * 1000


def lag(sec):
    if sec is None:
        return "n/a"
    if sec < 0:
        return f"{sec/60:.1f} min (FUTURE — clock skew?)"
    if sec < 5400:
        return f"{sec/60:.1f} min"
    if sec < 172800:
        return f"{sec/3600:.1f} h"
    return f"{sec/86400:.1f} d"


def unwrap(body):
    try:
        d = json.loads(body)
    except Exception:  # noqa: BLE001
        return None, None
    if isinstance(d, dict) and "data" in d:
        return d["data"], d.get("metadata")
    if isinstance(d, list):
        return d, None
    return None, None


def analyze(name, kind, url):
    st, hdr, body, ms = get(url)
    print(f"\n## {name} — {kind}")
    print(f"   GET {url}")
    print(f"   status={st}  {ms:.0f} ms")
    rl = {k: v for k, v in hdr.items() if "ratelimit" in k.lower() or "x-rate" in k.lower()}
    if rl:
        print(f"   ratelimit headers: {rl}")
    if st != 200:
        print(f"   FAIL. body[:300]={body[:300]!r}")
        return None
    data, meta = unwrap(body)
    if data is None:
        print(f"   FAIL: unexpected envelope. body[:300]={body[:300]!r}")
        return None
    n = len(data)
    if n == 0:
        print("   FAIL: empty result set")
        return None
    ts = sorted((x.get("created_utc", 0) for x in data), reverse=True)
    newest, oldest = ts[0], ts[-1]
    scores = [x.get("score") for x in data if "score" in x]
    zero_ish = sum(1 for s in scores if s in (0, 1))
    top = data[0]
    print(f"   returned {n}; newest {lag(NOW - newest)} ago (epoch {newest}); batch span {lag(newest - oldest)}")
    if scores:
        print(f"   scores: {zero_ish}/{len(scores)} are 0/1 (archived-at-creation proxy); sample={scores[:8]}")
    flair = top.get("link_flair_text") or top.get("author_flair_text")
    txt = (top.get("title") or top.get("body") or "")[:80].replace("\n", " ")
    fields = sorted(top.keys())
    print(f"   newest: u/{top.get('author')} flair={flair!r} :: {txt!r}")
    print(f"   fields present ({len(fields)}): {fields}")
    if meta:
        print(f"   metadata: total_results={meta.get('total_results')} timed_out={meta.get('timed_out')}")
    return {"newest_lag_s": NOW - newest, "n": n, "zero": (zero_ish, len(scores))}


def main():
    print(f"Probe @ epoch {NOW} (UTC {time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(NOW))})  sub=r/{SUB}  N={N}")
    r = {
        "pp_sub": analyze("PullPush", "submissions", f"{PP}/search/submission/?subreddit={SUB}&size={N}&sort=desc"),
        "pp_com": analyze("PullPush", "comments", f"{PP}/search/comment/?subreddit={SUB}&size={N}&sort=desc"),
        "as_sub": analyze("Arctic-Shift", "posts", f"{AS}/posts/search?subreddit={SUB}&limit={N}&sort=desc"),
        "as_com": analyze("Arctic-Shift", "comments", f"{AS}/comments/search?subreddit={SUB}&limit={N}&sort=desc"),
    }
    print("\n\n=== VERDICT (newest-item lag; lower = fresher = better for a live radar) ===")
    f = lambda x: lag(x["newest_lag_s"]) if x else "FAIL"
    print(f"  PullPush      posts={f(r['pp_sub']):<18} comments={f(r['pp_com'])}")
    print(f"  Arctic-Shift  posts={f(r['as_sub']):<18} comments={f(r['as_com'])}")


if __name__ == "__main__":
    main()
