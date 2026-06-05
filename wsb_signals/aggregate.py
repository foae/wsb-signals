"""Windowed aggregator — mentions → (ticker, window) empirical features (Phase 1).

For the current clock-aligned tumbling window it computes sov (PRIMARY rank), velocity/accel,
net_dir, dd_count, flair_counts, a baseline-gated z, and the composite H_e (signal-framework
§2–§5). SoV-primary: z is COMPUTED but kept off the H_e blend until its hour-of-week baseline is
`ready` (config weight stays 0 until then). Forward-only — baselines warm from live data, no
backfill. H_e components are standardized cross-sectionally by max-normalization (scaled by the
window max, negatives floored to 0) so they share a [0,1] scale before the weighted blend — see
`_max_norm` for why max-norm, not percentile rank.
"""
from __future__ import annotations

import json
import time
from collections import Counter, defaultdict
from pathlib import Path

from .db import DB, pretty_name
from .models import EmpiricalFeature


def hour_of_week(epoch: int) -> int:
    """0..167 — Monday 00:00 UTC = 0 (session-aware baselines, signal-framework §4)."""
    t = time.gmtime(epoch)
    return t.tm_wday * 24 + t.tm_hour


def window_start_for(now: int, window_seconds: int) -> int:
    """Clock-aligned tumbling window containing `now`."""
    return (now // window_seconds) * window_seconds


def _max_norm(values: list[float]) -> list[float]:
    """Scale to [0,1] by the window max (negatives floored to 0); all-zero → zeros.

    Max-norm — NOT percentile rank — because H_e must stay SoV-primary: percentile rank
    flattens 1st-vs-2nd SoV into a tiny gap, letting secondaries (net_dir) override the
    primary signal, and it hands tied all-zero components (first-window rank_delta/dd_count)
    a spurious 1.0. Max-norm preserves the leader's magnitude and zeroes empty components.
    """
    vmax = max(values, default=0.0)
    if vmax <= 0:
        return [0.0] * len(values)
    return [max(0.0, v) / vmax for v in values]


def aggregate_window(
    db: DB,
    window_start: int,
    window_seconds: int,
    *,
    weights: dict,
    min_samples_ready: int,
    min_authors_full: float = 1.0,
) -> list[EmpiricalFeature]:
    end = window_start + window_seconds
    rows = db.mentions_in_window(window_start, end)
    if not rows:
        return []

    # group by ticker, dedup things by thing_id (one mention per (ticker, thing) — §2.1 grain)
    per: dict[str, dict] = defaultdict(
        lambda: {"things": set(), "authors": set(), "bull": 0, "bear": 0, "dd": set(), "flairs": Counter()}
    )
    for ticker, thing_id, thing_type, author, flair, direction in rows:
        d = per[ticker]
        if thing_id in d["things"]:
            continue
        d["things"].add(thing_id)
        if author:
            d["authors"].add(author)
        if direction == "bull":
            d["bull"] += 1
        elif direction == "bear":
            d["bear"] += 1
        if flair:
            d["flairs"][flair] += 1
            if thing_type == "post" and flair.strip().upper() == "DD":
                d["dd"].add(thing_id)

    total = sum(len(d["things"]) for d in per.values()) or 1
    prior = db.features_at(window_start - window_seconds)         # mentions(W−1), velocity(W−1)
    prior_exists = bool(prior)                                    # was W−1 aggregated at all?
    prior_ranks = db.sov_ranks_at(window_start - window_seconds)  # rank(W−1)

    # baselines: prior windows in the same hour-of-week bucket (forward-only)
    how = hour_of_week(window_start)
    base: dict[str, list[int]] = defaultdict(list)
    for tk, ws, m in db.feature_history(window_start):
        if hour_of_week(ws) == how:
            base[tk].append(m)

    # first pass — raw features per ticker
    feats: list[dict] = []
    for t, d in per.items():
        m = len(d["things"])
        if prior_exists:
            # W−1 was aggregated, so a ticker absent from it genuinely had 0 mentions then
            # (velocity = m is a real new-arrival breakout). accel needs W−1's stored velocity,
            # which is itself None if W−2 was missing → then accel is undefined.
            pm = prior.get(t, {}).get("mentions") or 0
            velocity = float(m - pm)
            pv = prior.get(t, {}).get("velocity")
            accel = float(velocity - pv) if pv is not None else None
        else:
            # No prior window at all (cold start, or a gap in the run loop). velocity/accel are
            # UNDEFINED: emitting 0-based deltas here would make EVERY ticker look like a fresh
            # breakout (velocity=m, accel=m) and inflate H_e. Leave them null → they contribute
            # nothing to the blend (signal-framework §2.2 — momentum needs a real predecessor).
            velocity = accel = None
        bull, bear = d["bull"], d["bear"]
        net_dir = (bull - bear) / (bull + bear) if (bull + bear) else 0.0
        samples = base.get(t, [])
        status, z = "cold", None
        # max(2, …): the sample variance divides by (n−1), so a misconfigured min_samples_ready=1
        # would be a ZeroDivisionError — never treat a single sample as `ready`.
        if len(samples) >= max(2, min_samples_ready):
            status = "ready"
            mean = sum(samples) / len(samples)
            var = sum((x - mean) ** 2 for x in samples) / (len(samples) - 1)
            sd = var ** 0.5
            z = (m - mean) / sd if sd > 0 else None
        elif samples:
            status = "warming"
        feats.append({
            "ticker": t, "mentions": m, "authors": len(d["authors"]), "sov": m / total,
            "velocity": velocity, "accel": accel, "net_dir": net_dir, "dd_count": len(d["dd"]),
            # sort_keys → canonical JSON: the stored string can't depend on flair-encounter order
            # (which would otherwise vary with DB row order). Determinism, not cosmetics.
            "flair_counts": json.dumps(dict(d["flairs"]), sort_keys=True), "z": z, "baseline_status": status,
        })

    # rank_delta: prior rank − current rank (+ve = climbing the SoV board). Tie-break equal-SoV
    # tickers by `ticker` so the rank (and thus rank_delta) is deterministic, not dependent on
    # mention/row iteration order.
    cur_rank = {f["ticker"]: r for r, f in enumerate(sorted(feats, key=lambda f: (-f["sov"], f["ticker"])), 1)}
    for f in feats:
        pr = prior_ranks.get(f["ticker"])
        f["rank_delta"] = float(pr - cur_rank[f["ticker"]]) if pr else 0.0

    # normalize components to [0,1] by window max, then weighted blend → H_e (SoV-primary)
    sov_n = _max_norm([f["sov"] for f in feats])
    acc_n = _max_norm([f["accel"] if f["accel"] is not None else 0.0 for f in feats])  # None/neg → 0
    rd_n = _max_norm([f["rank_delta"] for f in feats])        # all-zero (first window) → zeros
    au_n = _max_norm([float(f["authors"]) for f in feats])
    dd_n = _max_norm([float(f["dd_count"]) for f in feats])   # no DD posts → zeros
    z_n = _max_norm([f["z"] if f["z"] is not None else 0.0 for f in feats])

    w = weights
    out: list[EmpiricalFeature] = []
    for i, f in enumerate(feats):
        z_ready = f["baseline_status"] == "ready" and f["z"] is not None
        h_e = (
            w["sov"] * sov_n[i]
            + w["accel"] * acc_n[i]
            + w["rank_delta"] * rd_n[i]
            + w["authors"] * au_n[i]
            + w["conviction"] * dd_n[i]
            + w["net_dir"] * abs(f["net_dir"])
            + (w["z"] * z_n[i] if z_ready else 0.0)
        )
        # Support shrink: a thin-evidence row (1–2 distinct authors) must not top the board off
        # max-normalized momentum alone — in a quiet window a single mention max-norms to 1.0 on
        # every component. Damp the *absolute* H_e toward 0 until `min_authors_full` distinct
        # authors back it. This is an absolute-confidence axis, distinct from the relative
        # `authors` component above (signal-framework §4: rank on robust support, not raw counts).
        if min_authors_full > 0:
            h_e *= min(1.0, f["authors"] / min_authors_full)
        out.append(EmpiricalFeature(
            ticker=f["ticker"], window_start=window_start, mentions=f["mentions"],
            authors=f["authors"], sov=f["sov"], velocity=f["velocity"], accel=f["accel"],
            z=f["z"], net_dir=f["net_dir"], dd_count=f["dd_count"],
            flair_counts=f["flair_counts"], baseline_status=f["baseline_status"], h_e=h_e,
        ))
    # Canonical board order: H_e-primary, with an explicit total-order tie-break chain down to
    # `ticker` so equal-H_e rows have ONE deterministic ordering — reproducible run-to-run and
    # well-defined for any future re-implementation (the board must not depend on DB row order or
    # dict-insertion order). Ties cascade H_e → sov → authors → mentions → ticker.
    out.sort(key=lambda r: (-r.h_e, -r.sov, -r.authors, -r.mentions, r.ticker))
    return out


def write_snapshot(
    rows: list[EmpiricalFeature],
    window_start: int,
    window_seconds: int,
    path: Path,
    generated_at: int,
    analytical: dict | None = None,
    movers: list | None = None,
    names: dict | None = None,
    min_window_mentions: int | None = None,
    capped: bool = False,
) -> None:
    """Write the dashboard's JSON contract (the daemon's output; avoids DuckDB write-lock contention).

    `analytical` maps ticker → AnalyticalFeature (Phase-2 market overlay); market fields are null
    for tickers outside the fetched top-N. `movers` is the screener list (for the STEALTH teaser).
    `names` maps symbol → raw company name (from ticker_names); displayed alongside every ticker.
    `min_window_mentions`: when the window's TOTAL mentions fall below this, the snapshot is flagged
    `quiet` so the dashboard can banner the board as low-confidence (off-hours single-mention noise).
    `capped`: the source poll hit its pagination cap (window incomplete) → flagged so the board can
    banner the SoV as untrustworthy (data-model invariant 14).
    """
    analytical = analytical or {}
    names = names or {}
    total_mentions = sum(r.mentions for r in rows)
    out_rows = []
    for i, r in enumerate(rows, 1):
        a = analytical.get(r.ticker)
        out_rows.append({
            "rank": i, "ticker": r.ticker, "name": pretty_name(names.get(r.ticker)),
            "mentions": r.mentions, "authors": r.authors,
            "sov": round(r.sov, 4), "velocity": r.velocity, "accel": r.accel,
            "z": (round(r.z, 3) if r.z is not None else None), "net_dir": round(r.net_dir, 3),
            "dd_count": r.dd_count, "baseline_status": r.baseline_status, "h_e": round(r.h_e, 4),
            "ret": (round(a.ret, 4) if a and a.ret is not None else None),
            "rvol": (round(a.rvol, 3) if a and a.rvol is not None else None),
            "rvol_conf": (a.rvol_conf if a else None),
            "h_m": (round(a.h_m, 4) if a else None),
        })
    payload = {
        "window_start": window_start,
        "window_end": window_start + window_seconds,
        "window_seconds": window_seconds,
        "generated_at": generated_at,
        "total_mentions": total_mentions,
        "quiet": (min_window_mentions is not None and total_mentions < min_window_mentions),
        # `capped`: the poll hit its pagination cap → the window is undercounted → `sov` is
        # untrustworthy (data-model invariant 14). Surfaced so the board can banner it low-trust.
        "capped": capped,
        "rows": out_rows,
    }
    if movers is not None:
        payload["movers"] = [
            {"symbol": m.symbol, "name": pretty_name(names.get(m.symbol)), "kind": m.kind,
             "rank": m.rank, "price": m.price, "percent_change": m.percent_change, "volume": m.volume}
            for m in movers
        ]
    # Atomic write: the dashboard reads this file concurrently; a torn read on a half-written
    # file would surface as transient "no data". Write to a temp sibling, then atomic replace.
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2))
    tmp.replace(path)


def write_history(db: DB, path: Path) -> None:
    """Atomically refresh the history Parquet the dashboard's time views read (lock-free, like the
    JSON snapshot). Cheap full dump — the table is hourly-grained, so even years stay small."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    db.export_history_parquet(tmp)
    tmp.replace(path)


def run_aggregation(db: DB, settings, now: int, snapshot_path: Path | None = None,
                    names: dict | None = None, capped: bool = False):
    """Aggregate the window containing `now`, persist features, optionally write the snapshot.

    When a snapshot is written (i.e. for the current window, not the W−1 finalization pass) we also
    refresh history.parquet so the dashboard's day/month views stay current. `capped` (from the poll)
    flows into the snapshot so the board can banner an incomplete window (data-model invariant 14).
    """
    window_seconds = settings.ingest["window_seconds"]
    heat = settings.cfg["heat"]
    ws = window_start_for(now, window_seconds)
    rows = aggregate_window(
        db, ws, window_seconds,
        weights=heat["weights"],
        min_samples_ready=settings.cfg["baseline"]["min_samples_ready"],
        min_authors_full=heat.get("min_authors_full", 1.0),
    )
    db.upsert_empirical_features(rows)
    if snapshot_path is not None:
        if names is None:
            names = db.ticker_names()
        write_snapshot(rows, ws, window_seconds, snapshot_path, now, names=names,
                       min_window_mentions=heat.get("min_window_mentions"), capped=capped)
        write_history(db, settings.data_dir / "history.parquet")
    return ws, rows
