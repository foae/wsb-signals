"""History layer — the Parquet export (radar side) and the dashboard rollup helpers.

The export is the lock-free read path: empirical_features is the spine, market is LEFT-joined
(sparse), and the company name is attached. The rollup helpers turn that hourly frame into the
day/month views.
"""
import pandas as pd
import pytest

from wsb_signals.aggregate import write_history
from wsb_signals.dashboard import daily_rollup, heatmap_pivot, ticker_series
from wsb_signals.db import DB
from wsb_signals.models import AnalyticalFeature, EmpiricalFeature


def test_export_history_parquet_join_and_sparse_market(tmp_path):
    db = DB(tmp_path / "t.duckdb")
    db.init_schema()
    db.upsert_ticker_names([("NVDA", "NVIDIA CORP"), ("AMD", "AMD INC")])
    db.upsert_empirical_features([
        EmpiricalFeature(ticker="NVDA", window_start=3600, mentions=5, authors=3, sov=0.7,
                         h_e=0.6, baseline_status="cold"),
        EmpiricalFeature(ticker="AMD", window_start=3600, mentions=2, authors=2, sov=0.3,
                         h_e=0.3, baseline_status="cold"),
    ])
    # Only NVDA gets a market row → AMD's h_m must come back NULL (sparse-by-design).
    db.upsert_analytical_features([
        AnalyticalFeature(ticker="NVDA", window_start=3600, ret=0.05, rvol=1.2, h_m=0.8),
    ])
    out = tmp_path / "history.parquet"
    write_history(db, out)
    db.close()

    df = pd.read_parquet(out)
    assert len(df) == 2
    assert {"ticker", "window_start", "mentions", "sov", "h_e", "ret", "rvol", "h_m",
            "name_raw"}.issubset(df.columns)
    nvda = df[df.ticker == "NVDA"].iloc[0]
    assert nvda["h_m"] == pytest.approx(0.8) and nvda["name_raw"] == "NVIDIA CORP"
    assert pd.isna(df[df.ticker == "AMD"].iloc[0]["h_m"])     # LEFT JOIN → NULL market
    assert not out.with_suffix(".parquet.tmp").exists()       # atomic temp cleaned up


def _hist_df() -> pd.DataFrame:
    """Two days of hourly-grained history (as load_history would yield: dt + date columns)."""
    d1, d2 = pd.Timestamp("2026-06-01", tz="UTC"), pd.Timestamp("2026-06-02", tz="UTC")
    rows = [
        {"ticker": "AAA", "date": d1, "dt": d1 + pd.Timedelta(hours=10), "mentions": 10, "sov": 0.5, "h_e": 0.6},
        {"ticker": "BBB", "date": d1, "dt": d1 + pd.Timedelta(hours=11), "mentions": 4, "sov": 0.2, "h_e": 0.3},
        {"ticker": "AAA", "date": d2, "dt": d2 + pd.Timedelta(hours=10), "mentions": 2, "sov": 0.1, "h_e": 0.2},
        {"ticker": "CCC", "date": d2, "dt": d2 + pd.Timedelta(hours=12), "mentions": 8, "sov": 0.4, "h_e": 0.5},
    ]
    return pd.DataFrame(rows)


def test_daily_rollup():
    out = daily_rollup(_hist_df())
    assert list(out["date"]) == ["2026-06-02", "2026-06-01"]        # newest first
    jun2, jun1 = out.iloc[0], out.iloc[1]
    assert jun2["total_mentions"] == 10 and jun2["n_tickers"] == 2
    assert jun2["top_tickers"] == "CCC, AAA"                        # 8 > 2
    assert jun1["total_mentions"] == 14 and jun1["top_tickers"] == "AAA, BBB"


def test_heatmap_pivot_mentions_topk():
    # totals: AAA=12, CCC=8, BBB=4 → top-2 = AAA, CCC (ordered by total desc)
    piv = heatmap_pivot(_hist_df(), "mentions", top_k=2)
    assert list(piv.index) == ["AAA", "CCC"]
    assert list(piv.columns) == ["2026-06-01", "2026-06-02"]
    assert piv.loc["AAA", "2026-06-01"] == 10 and piv.loc["AAA", "2026-06-02"] == 2
    assert pd.isna(piv.loc["CCC", "2026-06-01"]) and piv.loc["CCC", "2026-06-02"] == 8


def test_heatmap_pivot_he_uses_daily_max():
    # h_e aggregates by daily MAX; top-3 by summed daily-max: AAA=0.8, CCC=0.5, BBB=0.3
    piv = heatmap_pivot(_hist_df(), "h_e", top_k=3)
    assert list(piv.index) == ["AAA", "CCC", "BBB"]
    assert piv.loc["AAA", "2026-06-01"] == pytest.approx(0.6)


def test_ticker_series_filters_and_sorts():
    df = _hist_df()
    allrows = ticker_series(df, "AAA", None)
    assert list(allrows["ticker"]) == ["AAA", "AAA"]
    assert allrows["dt"].is_monotonic_increasing
    # a 0-day window keeps only the latest point for that ticker
    assert len(ticker_series(df, "AAA", 0)) == 1
