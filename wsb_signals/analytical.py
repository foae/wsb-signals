"""Market overlay (Phase 2) — analytical features H_m for the WSB-hot list.

v0.0.1 increment: STOCK-derived `ret` + `rvol` (low-confidence on thin free IEX volume) → H_m,
plus the free screeners (most-actives + movers) captured market-wide for STEALTH (v0.0.2).
Options-derived pcr/atm_iv/breadth enrich H_m in the next increment. H_m is max-normalized over
the hot list (same rationale as H_e — keeps magnitude; see aggregate._max_norm).

CAVEAT (v0.0.1): `ret` is DAY-to-date (price vs prev close) and `rvol` is cumulative day volume
vs prev FULL-day volume — both are DAILY measures, not aligned to the 1h WSB window. So a stock
can read market-hot all day off a stale open move, and early-session rvol is structurally small.
A window-aligned overlay (intraday bars) is a Phase-2+ increment; for now H_m answers "hot today",
not "hot this hour". Don't over-read divergence at fine time resolution until then.
"""
from __future__ import annotations

from .aggregate import _max_norm
from .models import AnalyticalFeature, StockSnapshot


def compute_analytical(
    snapshots: dict[str, StockSnapshot], window_start: int, weights: dict
) -> list[AnalyticalFeature]:
    items = list(snapshots.values())
    rets: list[float | None] = []
    rvols: list[float | None] = []
    for s in items:
        rets.append((s.price - s.prev_close) / s.prev_close if (s.price is not None and s.prev_close) else None)
        rvols.append(s.day_volume / s.prev_volume if (s.day_volume is not None and s.prev_volume) else None)

    absret_n = _max_norm([abs(r) if r is not None else 0.0 for r in rets])
    rvol_n = _max_norm([v if v is not None else 0.0 for v in rvols])
    w = weights
    out: list[AnalyticalFeature] = []
    for i, s in enumerate(items):
        h_m = w.get("ret", 0.0) * absret_n[i] + w.get("rvol", 0.0) * rvol_n[i]
        out.append(AnalyticalFeature(
            ticker=s.ticker, window_start=window_start,
            ret=rets[i], rvol=rvols[i], rvol_conf="low", h_m=h_m,
        ))
    return out


def overlay_market(db, settings, window_start: int, empirical_rows, market):
    """Fetch market for the top-N hot tickers + screeners; persist; return (analytical_by_ticker, movers)."""
    mkt = settings.cfg["market"]
    top = [r.ticker for r in empirical_rows[: mkt["top_n"]]]
    snaps = market.snapshots(top)
    analytical = compute_analytical(snaps, window_start, mkt["weights"])
    db.upsert_analytical_features(analytical)
    movers = market.screeners(mkt["screener_top"])
    db.upsert_movers(movers)
    return {a.ticker: a for a in analytical}, movers
