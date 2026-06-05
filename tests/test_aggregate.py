"""Aggregator correctness tests — the numeric core of H_e.

Focus on the bugs that the empirical-foundation pass fixed:
  - velocity/accel are NULL when no prior window exists (a gap must not read as a breakout);
  - velocity = m for a ticker absent from an EXISTING prior window (a genuine new arrival);
  - thin-support rows are damped by min_authors_full so single mentions can't top the board;
  - the SoV denominator and per-thing dedup are correct;
  - quiet windows are flagged in the snapshot.
"""
import json

import pytest

from wsb_signals.aggregate import (
    _max_norm,
    aggregate_window,
    hour_of_week,
    window_start_for,
    write_snapshot,
)
from wsb_signals.db import DB
from wsb_signals.models import EmpiricalFeature, Mention

WINDOW = 3600
WS = 3600          # current window [3600, 7200); prior window starts at 0
PRIOR_WS = WS - WINDOW
WEIGHTS = {"sov": 0.35, "accel": 0.15, "rank_delta": 0.15, "authors": 0.15,
           "conviction": 0.10, "net_dir": 0.10, "z": 0.00}


@pytest.fixture
def db(tmp_path):
    d = DB(tmp_path / "t.duckdb")
    d.init_schema()
    yield d
    d.close()


def _mention(ticker, thing_id, author, *, ttype="comment", direction="neutral", t=WS):
    return Mention(ticker=ticker, thing_id=thing_id, thing_type=ttype,
                   created_utc=t, author=author, flair=None, direction=direction)


def _agg(db, **kw):
    return aggregate_window(db, WS, WINDOW, weights=WEIGHTS, min_samples_ready=8, **kw)


# --- _max_norm ----------------------------------------------------------------

def test_max_norm_scales_by_max():
    assert _max_norm([1.0, 2.0, 4.0]) == [0.25, 0.5, 1.0]


def test_max_norm_floors_negatives_and_handles_all_zero():
    assert _max_norm([-3.0, 0.0, 6.0]) == [0.0, 0.0, 1.0]
    assert _max_norm([0.0, 0.0]) == [0.0, 0.0]
    assert _max_norm([]) == []


# --- window helpers -----------------------------------------------------------

def test_window_start_is_clock_aligned():
    assert window_start_for(7250, 3600) == 7200


def test_hour_of_week_bucket():
    assert 0 <= hour_of_week(WS) < 168


# --- prior-window guard (the core fix) ----------------------------------------

def test_no_prior_window_yields_null_velocity_accel(db):
    """A gap / cold start: W−1 was never aggregated → momentum is undefined, not a breakout."""
    db.upsert_mentions([_mention("NVDA", "c1", "alice"), _mention("NVDA", "c2", "bob")])
    rows = _agg(db)
    assert len(rows) == 1
    assert rows[0].velocity is None
    assert rows[0].accel is None


def test_prior_window_present_computes_velocity(db):
    """W−1 exists with this ticker → velocity = m − m_prev, accel = velocity − velocity_prev."""
    db.upsert_empirical_features([EmpiricalFeature(
        ticker="NVDA", window_start=PRIOR_WS, mentions=2, authors=2, sov=1.0,
        velocity=1.0, accel=0.0, baseline_status="cold", h_e=0.5)])
    db.upsert_mentions([_mention("NVDA", f"c{i}", f"u{i}") for i in range(5)])  # m = 5
    rows = _agg(db)
    assert rows[0].velocity == pytest.approx(3.0)      # 5 − 2
    assert rows[0].accel == pytest.approx(2.0)         # 3 − 1


def test_new_arrival_in_existing_prior_window(db):
    """W−1 exists (another ticker) but this one is absent → it genuinely had 0 → velocity = m;
    accel stays None because the absent ticker has no prior velocity."""
    db.upsert_empirical_features([EmpiricalFeature(
        ticker="AMD", window_start=PRIOR_WS, mentions=4, authors=3, sov=1.0,
        velocity=1.0, accel=0.0, baseline_status="cold", h_e=0.5)])
    db.upsert_mentions([_mention("NVDA", f"c{i}", f"u{i}") for i in range(3)])  # m = 3
    rows = {r.ticker: r for r in _agg(db)}
    assert rows["NVDA"].velocity == pytest.approx(3.0)
    assert rows["NVDA"].accel is None


# --- SoV denominator + per-thing dedup ----------------------------------------

def test_sov_denominator_and_dedup(db):
    # A in 3 distinct things, B in 2 → total = 5 distinct (ticker, thing) cells.
    db.upsert_mentions([_mention("AAA", f"a{i}", f"u{i}") for i in range(3)]
                       + [_mention("BBB", f"b{i}", f"u{i}") for i in range(2)])
    rows = {r.ticker: r for r in _agg(db)}
    assert rows["AAA"].mentions == 3 and rows["AAA"].sov == pytest.approx(0.6)
    assert rows["BBB"].mentions == 2 and rows["BBB"].sov == pytest.approx(0.4)


# --- support damping ----------------------------------------------------------

def _single_ticker_h_e(db, n_authors, min_authors_full):
    db.con.execute("DELETE FROM mentions")
    db.upsert_mentions([_mention("XYZ", f"t{i}", f"author{i}") for i in range(n_authors)])
    rows = _agg(db, min_authors_full=min_authors_full)
    return rows[0].h_e


def test_support_damp_shrinks_thin_rows(db):
    """One ticker fills the window, so every max-normed component is 1.0 and the blend is fixed;
    only the support shrink differs. 1 author ⇒ ~⅓ of the full-support H_e."""
    full = _single_ticker_h_e(db, n_authors=3, min_authors_full=3)   # damp = 1.0
    thin = _single_ticker_h_e(db, n_authors=1, min_authors_full=3)   # damp = 1/3
    assert full == pytest.approx(0.50)          # 0.35 (sov) + 0.15 (authors); accel None, neutral
    assert thin == pytest.approx(full / 3.0)


# --- quiet-window flag --------------------------------------------------------

def test_quiet_flag_in_snapshot(tmp_path):
    rows = [EmpiricalFeature(ticker="NVDA", window_start=WS, mentions=3, authors=2, sov=1.0,
                             baseline_status="cold", h_e=0.4)]
    snap = tmp_path / "leaderboard.json"

    write_snapshot(rows, WS, WINDOW, snap, WS, min_window_mentions=20)
    p = json.loads(snap.read_text())
    assert p["total_mentions"] == 3 and p["quiet"] is True

    write_snapshot(rows, WS, WINDOW, snap, WS, min_window_mentions=2)
    p = json.loads(snap.read_text())
    assert p["quiet"] is False

    write_snapshot(rows, WS, WINDOW, snap, WS)   # no threshold → never quiet
    p = json.loads(snap.read_text())
    assert p["quiet"] is False


# --- deterministic ranking (canonical tie-break) -------------------------------

def test_ranking_is_deterministic_under_input_order(db):
    """Equal-scored tickers must get ONE canonical order (ticker asc), independent of the order
    mentions were inserted. Pre-fix the board echoed DB/insertion order for ties (nondeterministic);
    now `out.sort` breaks ties by (h_e, sov, authors, mentions, ticker)."""
    def board(order):
        db.con.execute("DELETE FROM mentions")
        for tk in order:
            db.upsert_mentions([_mention(tk, f"{tk}1", "ua"), _mention(tk, f"{tk}2", "ub")])
        return [r.ticker for r in _agg(db)]

    # three tickers, identical mentions(2)/authors(2) → identical H_e → tie-break is ticker asc
    assert board(["CCC", "AAA", "BBB"]) == ["AAA", "BBB", "CCC"]
    assert board(["BBB", "CCC", "AAA"]) == ["AAA", "BBB", "CCC"]   # same output, different insert order


# --- capped-window flag --------------------------------------------------------

def test_capped_flag_in_snapshot(tmp_path):
    """A pagination-capped poll surfaces `capped=True` in the snapshot so the board can banner the
    window as low-trust (data-model invariant 14); default is False."""
    rows = [EmpiricalFeature(ticker="NVDA", window_start=WS, mentions=3, authors=2, sov=1.0,
                             baseline_status="cold", h_e=0.4)]
    snap = tmp_path / "leaderboard.json"

    write_snapshot(rows, WS, WINDOW, snap, WS, capped=True)
    assert json.loads(snap.read_text())["capped"] is True

    write_snapshot(rows, WS, WINDOW, snap, WS)   # default → not capped
    assert json.loads(snap.read_text())["capped"] is False
