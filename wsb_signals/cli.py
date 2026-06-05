"""WSB Signals CLI.

Commands:
  init-db          create the DuckDB schema
  build-whitelist  fetch the Alpaca ticker universe → whitelist/symbols.txt
  poll-once        one Arctic-Shift poll → extract → persist → raw smoke count
  aggregate        current window from stored mentions → H_e leaderboard + JSON snapshot
  market           aggregate + Alpaca market overlay (ret/rvol/H_m) + screeners → snapshot
  run              continuous loop: poll → H_e → market overlay → snapshot + heartbeat
  eval-extractor   extractor decision mix over a window (precision proxy)
  heartbeat        Arctic-Shift freshness probe (exit 0/1/2)
  dashboard        launch the minimal Streamlit board (reads the snapshot)

`poll-once` ranks by RAW mention count (a smoke check); `aggregate`/`run` compute the real
SoV-primary, baseline-gated H_e (signal-framework §4–§5).
"""
from __future__ import annotations

import argparse
import signal
import subprocess
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

from .aggregate import run_aggregation, write_snapshot
from .analytical import overlay_market
from .assets import build_whitelist
from .classify import direction as classify_direction
from .config import Settings
from .db import DB, pretty_name
from .extract import TickerExtractor, has_trading_context
from .log import get_logger
from .market.alpaca import AlpacaMarketData
from .models import Mention
from .sources.arctic_shift import ArcticShiftSource


def _market_client(s: Settings) -> AlpacaMarketData | None:
    key, sec, data_url = s.alpaca_creds()
    if not key or not sec:
        return None
    return AlpacaMarketData(key, sec, data_url=data_url, feed=s.cfg["market"]["feed"],
                            user_agent=s.ingest["user_agent"])

log = get_logger("wsb")


def _arctic_source(s: Settings) -> ArcticShiftSource:
    ing = s.ingest
    return ArcticShiftSource(
        s.arctic_base, ing["subreddit"], page_limit=ing["page_limit"],
        max_pages=ing["max_pages"], user_agent=ing["user_agent"], timeout=ing["request_timeout"])


def _last_poll_at(s: Settings) -> int | None:
    """Persisted epoch of the most recent `run` poll, or None if never polled.

    Survives process restarts so a rapid service bounce doesn't re-pull the source
    within the configured minimum gap. Lives in data/ (gitignored, derived).
    """
    try:
        return int((s.data_dir / ".last_poll").read_text().strip())
    except (OSError, ValueError):
        return None


def _mark_poll(s: Settings, ts: int) -> None:
    marker = s.data_dir / ".last_poll"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(str(ts))


def _build_extractor(s: Settings) -> TickerExtractor:
    regex = s.extract["candidate_regex"]
    wl = s.whitelist_path
    if wl and not wl.exists():
        # Fail CLOSED: a missing whitelist must not silently degrade to bare-token extraction
        # (that floods the board with uppercase non-tickers). Accept $-cashtags only until built.
        log.warning("whitelist configured but %s missing — run `wsb build-whitelist`; "
                    "running CASHTAG-ONLY (bare tokens rejected) until it exists", wl)
        return TickerExtractor.cashtag_only(s.stoplist_path, regex=regex)
    amb = s.ambiguous_path
    if amb and not amb.exists():
        amb = None  # optional file; absence just disables the ambiguous-word gate
    return TickerExtractor.from_files(s.stoplist_path, regex=regex, whitelist_path=wl, ambiguous_path=amb)


def _mentions_from_poll(res, extractor: TickerExtractor, bots: set):
    """PollResult → (mentions, distinct-thing counts, authors). Direction classified per thing."""
    mentions: list[Mention] = []
    counts: Counter[str] = Counter()
    authors: dict[str, set[str]] = defaultdict(set)
    for p in res.posts:
        if p.author in bots:
            continue
        text = f"{p.title or ''} {p.selftext or ''}"
        d = classify_direction(text)
        for sym in set(extractor.extract(text)):
            mentions.append(Mention(ticker=sym, thing_id=p.id, thing_type="post",
                                    created_utc=p.created_utc, author=p.author,
                                    flair=p.link_flair_text, direction=d))
            counts[sym] += 1
            authors[sym].add(p.author)
    for c in res.comments:
        if c.author in bots:
            continue
        d = classify_direction(c.body)
        for sym in set(extractor.extract(c.body)):  # per-thing dedup (signal-framework §2.1 grain)
            mentions.append(Mention(ticker=sym, thing_id=c.id, thing_type="comment",
                                    created_utc=c.created_utc, author=c.author, direction=d))
            counts[sym] += 1
            authors[sym].add(c.author)
    return mentions, counts, authors


def cmd_init_db(args: argparse.Namespace) -> None:
    s = Settings.load()
    db = DB(s.db_path)
    db.init_schema()
    log.info("schema ready at %s", s.db_path)
    db.close()


def cmd_poll_once(args: argparse.Namespace) -> None:
    s = Settings.load()
    window = args.window or s.ingest["window_seconds"]
    src = _arctic_source(s)
    log.info("polling r/%s, last %d min…", s.ingest["subreddit"], window // 60)
    res = src.poll(window)
    src.close()
    log.info("pulled %d posts + %d comments (capped=%s)", len(res.posts), len(res.comments), res.capped)

    extractor = _build_extractor(s)
    bots = set(s.extract["bots"])
    mentions, counts, authors = _mentions_from_poll(res, extractor, bots)

    db = DB(s.db_path)
    db.init_schema()
    db.upsert_posts(res.posts)
    db.upsert_comments(res.comments)
    db.upsert_mentions(mentions)
    totals = db.table_counts()
    names = db.ticker_names()
    db.close()

    if not counts:
        log.info("no ticker candidates in window (quiet hour?) — try a wider --window")
    else:
        ranked = sorted(counts.items(), key=lambda kv: (-kv[1], -len(authors[kv[0]]), kv[0]))
        print("\n  raw mention leaderboard (SMOKE — not the SoV signal; use `wsb aggregate`):")
        for sym, n in ranked[: args.top]:
            print(f"    {sym:<6} {pretty_name(names.get(sym), 21):<22} mentions={n:<4} authors={len(authors[sym])}")
    print(
        f"\n  persisted this poll: {len(res.posts)} posts, {len(res.comments)} comments, "
        f"{len(mentions)} mentions"
    )
    print(f"  store totals: {totals} → {s.db_path}")


def cmd_build_whitelist(args: argparse.Namespace) -> None:
    s = Settings.load()
    key, sec, _ = s.alpaca_creds()
    if not key or not sec:
        log.error("ALPACA_API_KEY / ALPACA_API_SECRET missing from .env — cannot build whitelist")
        return
    endpoint = s.env.get("ALPACA_ENDPOINT_URL", "https://paper-api.alpaca.markets/v2")
    out = s.whitelist_path or (s.root / "whitelist" / "symbols.txt")
    log.info("fetching Alpaca asset universe…")
    assets = build_whitelist(key, sec, endpoint_url=endpoint, out_path=out,
                             user_agent=s.ingest["user_agent"], include_otc=args.include_otc)
    db = DB(s.db_path)
    db.init_schema()
    db.upsert_ticker_names(assets)
    db.close()
    log.info("wrote %d symbols → %s  (+ company names → ticker_names)", len(assets), out)


def cmd_eval_extractor(args: argparse.Namespace) -> None:
    s = Settings.load()
    ing = s.ingest
    window = args.window or ing["window_seconds"]
    src = _arctic_source(s)
    log.info("eval: polling r/%s, last %d min…", ing["subreddit"], window // 60)
    res = src.poll(window)
    src.close()

    ex = _build_extractor(s)
    bots = set(s.extract["bots"])

    decisions: Counter[str] = Counter()
    accepted: Counter[str] = Counter()
    not_listed: Counter[str] = Counter()
    acc_occ = ctx_occ = 0

    def handle(text: str | None) -> None:
        nonlocal acc_occ, ctx_occ
        if not text:
            return
        ctx = has_trading_context(text)
        for sym, d in ex.classify(text):
            decisions[d] += 1
            if d in TickerExtractor.ACCEPT:
                accepted[sym] += 1
                acc_occ += 1
                ctx_occ += int(ctx)
            elif d == "not_listed":
                not_listed[sym] += 1

    for p in res.posts:
        if p.author not in bots:
            handle(f"{p.title or ''} {p.selftext or ''}")
    for c in res.comments:
        if c.author not in bots:
            handle(c.body)

    total = sum(decisions.values()) or 1
    wl_state = f"ON ({len(ex.whitelist)} symbols)" if ex.whitelist is not None else "OFF"
    print(f"\n=== extractor eval — {len(res.posts)} posts + {len(res.comments)} comments, {window // 60}-min window ===")
    print(f"whitelist: {wl_state}")
    print(f"raw regex candidates: {total}")
    for d in ("cashtag", "whitelist_ok", "open_ok", "stop", "not_listed", "ambig_no_context", "too_short"):
        if decisions[d]:
            print(f"  {d:<16} {decisions[d]:>6}  ({100 * decisions[d] / total:4.1f}%)")
    print(f"accepted mentions: {acc_occ}  |  in trading context: {(100 * ctx_occ / acc_occ if acc_occ else 0):.0f}%")
    print("\n  top accepted tickers:")
    for sym, n in accepted.most_common(15):
        print(f"    {sym:<6} {n}")
    if not_listed:
        print("\n  top REJECTED (not in whitelist) — noise the whitelist removes:")
        for sym, n in not_listed.most_common(15):
            print(f"    {sym:<6} {n}")
    print("\n  NOTE: precision *proxy* (decision mix), not true precision/recall — the latter needs a")
    print("        hand-labelled sample (which candidates are genuinely tickers in context).")


def cmd_heartbeat(args: argparse.Namespace) -> None:
    """Probe Arctic-Shift freshness. Exit 0 = OK, 1 = stale, 2 = no data (tap likely down)."""
    s = Settings.load()
    thr = s.cfg["heartbeat"]["max_staleness_seconds"]
    src = _arctic_source(s)
    lag_c = src.newest_item_lag("comments")
    lag_p = src.newest_item_lag("posts")
    src.close()

    lags = [x for x in (lag_c, lag_p) if x is not None]
    if not lags:
        log.error("HEARTBEAT FAIL — Arctic-Shift returned no items; the sole live tap may be DOWN. "
                  "Runbook: radar STOPS (no free fallback — PullPush frozen, Reddit API excluded).")
        sys.exit(2)
    detail = (
        (f"comment={lag_c / 60:.1f} min" if lag_c is not None else "comment=?")
        + (f", post={lag_p / 60:.1f} min" if lag_p is not None else ", post=?")
        + f"; threshold={thr / 60:.0f} min"
    )
    if min(lags) <= thr:
        log.info("HEARTBEAT OK — %s", detail)
    else:
        log.error("HEARTBEAT STALE — %s. Lag exceeds threshold; treat the tap as degraded. "
                  "Runbook: pause the radar, re-test Arctic-Shift (and PullPush) before resuming.", detail)
        sys.exit(1)


def _print_leaderboard(window_start: int, rows: list, window_seconds: int, top: int, snap: Path, names: dict) -> None:
    if not rows:
        log.info("no mentions in the current window [%s UTC) — run `wsb poll-once` or `wsb run` first",
                 time.strftime("%H:%M", time.gmtime(window_start)))
        return
    a, b = time.gmtime(window_start), time.gmtime(window_start + window_seconds)
    print(f"\n=== WSB Heat — window {time.strftime('%H:%M', a)}–{time.strftime('%H:%M UTC', b)} "
          f"(top {top} by H_e) ===")
    print(f"{'#':<3}{'ticker':<7}{'name':<22}{'sov':>7}{'ment':>6}{'auth':>6}{'vel':>6}{'accel':>7}"
          f"{'netdir':>8}{'z':>7}{'base':>9}{'H_e':>7}")
    for i, r in enumerate(rows[:top], 1):
        z = f"{r.z:.2f}" if r.z is not None else "—"
        vel = f"{r.velocity:>6.0f}" if r.velocity is not None else f"{'—':>6}"
        acc = f"{r.accel:>7.0f}" if r.accel is not None else f"{'—':>7}"
        print(f"{i:<3}{r.ticker:<7}{pretty_name(names.get(r.ticker), 21):<22}{r.sov * 100:>6.1f}%{r.mentions:>6}"
              f"{r.authors:>6}{vel}{acc}{r.net_dir:>8.2f}{z:>7}{r.baseline_status:>9}{r.h_e:>7.3f}")
    print(f"\nsnapshot → {snap}   (z is baseline-gated: 'cold' until hour-of-week history accrues)")


def cmd_aggregate(args: argparse.Namespace) -> None:
    s = Settings.load()
    db = DB(s.db_path)
    db.init_schema()
    now = args.now or int(time.time())
    snap = s.data_dir / "leaderboard.json"
    names = db.ticker_names()
    ws, rows = run_aggregation(db, s, now, snapshot_path=snap, names=names)
    db.close()
    _print_leaderboard(ws, rows, s.ingest["window_seconds"], args.top, snap, names)


def _print_overlay(ws, rows, analytical, movers, window_seconds, top, snap, names):
    a0, b0 = time.gmtime(ws), time.gmtime(ws + window_seconds)
    print(f"\n=== WSB Heat + Market overlay — window {time.strftime('%H:%M', a0)}–"
          f"{time.strftime('%H:%M UTC', b0)} (top {top}) ===")
    print(f"{'#':<3}{'ticker':<7}{'name':<22}{'sov':>7}{'H_e':>7}{'ret':>8}{'rvol':>8}{'H_m':>7}")
    for i, r in enumerate(rows[:top], 1):
        a = analytical.get(r.ticker)
        ret = f"{a.ret * 100:+.1f}%" if (a and a.ret is not None) else "—"
        rvol = f"x{a.rvol:.2f}" if (a and a.rvol is not None) else "—"
        hm = f"{a.h_m:.3f}" if a else "—"
        print(f"{i:<3}{r.ticker:<7}{pretty_name(names.get(r.ticker), 21):<22}"
              f"{r.sov * 100:>6.1f}%{r.h_e:>7.3f}{ret:>8}{rvol:>8}{hm:>7}")
    if movers:
        acts = [m.symbol for m in movers if m.kind == "active"][:8]
        gain = [(m.symbol, m.percent_change) for m in movers if m.kind == "gainer" and m.percent_change is not None][:5]
        print(f"\nscreener most-actives: {', '.join(acts)}")
        print("screener top gainers: " + ", ".join(f"{sym}(+{p:.0f}%)" for sym, p in gain))
    print(f"\nsnapshot → {snap}  (ret/rvol are day-to-date, NOT window-aligned; rvol low-conf on free IEX; "
          "divergence/quadrants are Phase 3)")


def cmd_market(args: argparse.Namespace) -> None:
    s = Settings.load()
    db = DB(s.db_path)
    db.init_schema()
    now = args.now or int(time.time())
    snap = s.data_dir / "leaderboard.json"
    names = db.ticker_names()
    ws, rows = run_aggregation(db, s, now, snapshot_path=snap, names=names)
    if not rows:
        db.close()
        log.info("no empirical rows in the current window — run `wsb run` or `wsb poll-once` first")
        return
    market = _market_client(s)
    if market is None:
        db.close()
        log.error("ALPACA_API_KEY/SECRET missing from .env — cannot fetch market data")
        return
    analytical, movers = overlay_market(db, s, ws, rows, market)
    market.close()
    write_snapshot(rows, ws, s.ingest["window_seconds"], snap, now,
                   analytical=analytical, movers=movers, names=names,
                   min_window_mentions=s.cfg["heat"].get("min_window_mentions"))
    db.close()
    log.info("market overlay: %d tickers priced, %d screener movers", len(analytical), len(movers))
    _print_overlay(ws, rows, analytical, movers, s.ingest["window_seconds"], args.top, snap, names)


def _raise_keyboard_interrupt(signum, frame):
    """SIGTERM (how systemd/`kill` stops the daemon) → the same graceful path as Ctrl-C, so the
    `finally` block closes the source/market/DB cleanly instead of the process dying mid-write."""
    raise KeyboardInterrupt


def cmd_run(args: argparse.Namespace) -> None:
    s = Settings.load()
    ing = s.ingest
    interval = args.interval or ing["poll_seconds"]
    window = ing["window_seconds"]
    thr = s.cfg["heartbeat"]["max_staleness_seconds"]
    snap = s.data_dir / "leaderboard.json"

    extractor = _build_extractor(s)
    bots = set(s.extract["bots"])
    src = _arctic_source(s)
    db = DB(s.db_path)
    db.init_schema()
    market = None if args.no_market else _market_client(s)
    if market is None and not args.no_market:
        log.warning("market overlay disabled — ALPACA creds missing from .env (empirical-only)")
    names = db.ticker_names()  # static during the run; loaded once
    # Translate SIGTERM (systemd `stop`, `kill`) into a graceful shutdown. Only the main thread can
    # install handlers — ignore if embedded elsewhere (e.g. a test driver on a worker thread).
    try:
        signal.signal(signal.SIGTERM, _raise_keyboard_interrupt)
    except ValueError:
        pass
    log.info("run loop: interval=%ds, window=%d min, market=%s, forward-only (Ctrl-C / SIGTERM to stop)",
             interval, window // 60, "on" if market else "off")

    # Startup throttle: on a rapid service restart, don't re-pull the source until at
    # least `min_poll_gap_seconds` has elapsed since the last poll (persisted in data/).
    min_gap = int(ing.get("min_poll_gap_seconds", 60))
    last = _last_poll_at(s)
    if last is not None:
        elapsed = int(time.time()) - last
        if elapsed < 0:
            # Future-dated marker (clock skew / corruption): don't translate it into an
            # unbounded sleep — ignore it and poll now. The next poll rewrites the marker.
            log.warning("startup throttle: .last_poll is %ds in the future (clock skew?) — ignoring", -elapsed)
        elif elapsed < min_gap:
            wait = min_gap - elapsed   # bounded by min_gap since elapsed >= 0
            log.info("startup throttle: last poll %ds ago — waiting %ds before first pull (min gap %ds)",
                     elapsed, wait, min_gap)
            time.sleep(wait)
    try:
        while True:
            t0 = int(time.time())
            # Per-cycle guard: a transient fault (DB hiccup, source blip, parse error) must recover
            # on the next interval, not crash the daemon. KeyboardInterrupt/SystemExit derive from
            # BaseException, so `except Exception` lets shutdown signals through to the outer handler.
            try:
                res = src.poll(window)
                if not res.ok:
                    # Partial poll (Arctic-Shift errored mid-fetch): the window is undercounted, so
                    # the SoV denominator would be biased. Discard — don't persist/aggregate/mark —
                    # and retry next cycle. Not marking the poll also avoids the throttle suppressing
                    # a prompt retry after a restart.
                    log.error("poll incomplete (Arctic-Shift error mid-fetch) — skipping this cycle, will retry")
                else:
                    _mark_poll(s, t0)
                    mentions, _counts, _authors = _mentions_from_poll(res, extractor, bots)
                    db.upsert_posts(res.posts)
                    db.upsert_comments(res.comments)
                    db.upsert_mentions(mentions)
                    # Finalize the just-closed previous window first: this poll covers the full
                    # trailing `window` seconds, so it carries the prior window's last mentions — but
                    # aggregating only window_start_for(t0) would freeze that window short of its
                    # final interval (and poison its baseline). Re-aggregate it (persist-only, no
                    # snapshot) before the current window so the current window's velocity/accel read
                    # the finalized prior. Idempotent upsert.
                    run_aggregation(db, s, t0 - window)
                    ws, rows = run_aggregation(db, s, t0, snapshot_path=snap, names=names, capped=res.capped)

                    n_mkt = 0
                    if market is not None and rows:
                        try:
                            analytical, movers = overlay_market(db, s, ws, rows, market)
                            write_snapshot(rows, ws, window, snap, t0, analytical=analytical, movers=movers,
                                           names=names, min_window_mentions=s.cfg["heat"].get("min_window_mentions"),
                                           capped=res.capped)
                            n_mkt = len(analytical)
                        except Exception as e:  # noqa: BLE001 — market is best-effort, never kill the loop
                            log.warning("market overlay failed this cycle: %s", e)

                    lag = (t0 - res.newest_utc) if res.newest_utc else None
                    hb = "NO-DATA" if lag is None else ("OK" if lag <= thr else "STALE")
                    top = rows[0] if rows else None
                    log.info("cycle: +%d posts +%d comments, %d mentions, %d tickers (%d priced); top=%s; freshness=%s [%s]",
                             len(res.posts), len(res.comments), len(mentions), len(rows), n_mkt,
                             (f"{top.ticker} H_e={top.h_e:.2f}" if top else "—"),
                             (f"{lag // 60}min" if lag is not None else "?"), hb)
                    if hb != "OK":
                        log.error("freshness %s — Arctic-Shift is the sole live tap; see README runbook", hb)
            except Exception as e:  # noqa: BLE001 — self-heal: log and retry next interval
                log.exception("cycle failed (%s) — recovering, will retry next interval", e)

            if args.once:
                break
            time.sleep(max(5, interval - (int(time.time()) - t0)))
    except KeyboardInterrupt:
        log.info("run loop stopped (Ctrl-C / SIGTERM)")
    finally:
        src.close()
        if market is not None:
            market.close()
        db.close()


def cmd_dashboard(args: argparse.Namespace) -> None:
    s = Settings.load()
    dash = s.cfg.get("dashboard", {})
    addr = args.address or dash.get("address", "0.0.0.0")
    port = args.port or dash.get("port", 8501)
    app = Path(__file__).resolve().parent / "dashboard.py"
    log.info("launching Streamlit on %s:%s (reads the JSON snapshot; Ctrl-C to stop)…", addr, port)
    subprocess.run([
        sys.executable, "-m", "streamlit", "run", str(app),
        "--server.address", str(addr), "--server.port", str(port), "--server.headless", "true",
    ])


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="wsb", description="WSB Signals CLI")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init-db", help="create the DuckDB schema").set_defaults(func=cmd_init_db)

    pp = sub.add_parser("poll-once", help="one Arctic-Shift poll → extract → persist → raw count")
    pp.add_argument("--window", type=int, default=None, help="window seconds (default: config ingest.window_seconds)")
    pp.add_argument("--top", type=int, default=10, help="rows to print in the smoke leaderboard")
    pp.set_defaults(func=cmd_poll_once)

    bw = sub.add_parser("build-whitelist", help="fetch Alpaca asset universe → whitelist/symbols.txt")
    bw.add_argument("--include-otc", action="store_true", help="include OTC symbols (default: listed only)")
    bw.set_defaults(func=cmd_build_whitelist)

    ev = sub.add_parser("eval-extractor", help="poll a window, report extractor decision mix (precision proxy)")
    ev.add_argument("--window", type=int, default=None, help="window seconds (default: config ingest.window_seconds)")
    ev.set_defaults(func=cmd_eval_extractor)

    sub.add_parser(
        "heartbeat", help="check Arctic-Shift freshness; exit non-zero if stale (1) or down (2)"
    ).set_defaults(func=cmd_heartbeat)

    ag = sub.add_parser("aggregate", help="aggregate current window from stored mentions → H_e board + snapshot")
    ag.add_argument("--top", type=int, default=15, help="rows to print")
    ag.add_argument("--now", type=int, default=None, help="override 'now' epoch (testing)")
    ag.set_defaults(func=cmd_aggregate)

    mk = sub.add_parser("market", help="aggregate + Alpaca market overlay (ret/rvol/H_m) + screeners → snapshot")
    mk.add_argument("--top", type=int, default=15, help="rows to print")
    mk.add_argument("--now", type=int, default=None, help="override 'now' epoch (testing)")
    mk.set_defaults(func=cmd_market)

    rn = sub.add_parser("run", help="continuous loop: poll → extract → aggregate → market overlay → snapshot")
    rn.add_argument("--interval", type=int, default=None, help="seconds between cycles (default: config poll_seconds)")
    rn.add_argument("--once", action="store_true", help="run a single cycle and exit")
    rn.add_argument("--no-market", action="store_true", help="skip the market overlay (empirical only)")
    rn.set_defaults(func=cmd_run)

    dsh = sub.add_parser("dashboard", help="launch the Streamlit board (reads data/leaderboard.json)")
    dsh.add_argument("--address", default=None, help="bind address (default: config dashboard.address = 0.0.0.0)")
    dsh.add_argument("--port", type=int, default=None, help="port (default: config dashboard.port = 8501)")
    dsh.set_defaults(func=cmd_dashboard)

    args = p.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
