"""DuckDB store: full schema DDL + idempotent upserts for the ingestion slice.

Schema mirrors architecture §2.7. All tables are created up front (cheap, keeps
the schema reviewable in one place); only raw_posts / raw_comments / mentions are
written in v0.0.1's poll. `feed`/`as_of` carry provenance; `rvol_conf` flags thin
free-feed volume; outcome/P&L stays per-post (never aggregated — survivorship).
"""
from __future__ import annotations

import re
from pathlib import Path

import duckdb

from .models import AnalyticalFeature, EmpiricalFeature, Mention, Mover, RawComment, RawPost

# Trailing security-type descriptors Alpaca appends to equity names (not ETFs).
_NAME_SUFFIX = re.compile(
    r"\s*[,.]?\s+(?:Class\s+[A-Z]\s+)?"
    r"(?:Common Stock|Ordinary Shares|Common Shares|Depositary Shares|"
    r"American Depositary Shares|Depositary Receipts|Sponsored Adr)\s*$",
    re.IGNORECASE,
)


def pretty_name(raw: str | None, max_len: int = 0) -> str:
    """Human-readable company name from the raw (UPPERCASE) Alpaca name; '' if unknown.

    Title-cases ("BROADCOM INC. COMMON STOCK" → "Broadcom Inc."), strips the verbose
    security-type suffix (… Common Stock / Class A Common Stock / Ordinary Shares …) but leaves
    ETF names intact, and optionally truncates for terminal columns.
    """
    if not raw:
        return ""
    name = _NAME_SUFFIX.sub("", raw.title()).strip()
    if max_len and len(name) > max_len:
        name = name[: max_len - 1] + "…"
    return name

SCHEMA = """
CREATE TABLE IF NOT EXISTS raw_posts (
  id              VARCHAR PRIMARY KEY,
  created_utc     BIGINT,
  author          VARCHAR,
  title           VARCHAR,
  selftext        VARCHAR,
  link_flair_text VARCHAR,
  score           INTEGER,
  num_comments    INTEGER,
  retrieved_on    BIGINT,
  source          VARCHAR
);
CREATE TABLE IF NOT EXISTS raw_comments (
  id           VARCHAR PRIMARY KEY,
  created_utc  BIGINT,
  author       VARCHAR,
  link_id      VARCHAR,
  parent_id    VARCHAR,
  body         VARCHAR,
  score        INTEGER,
  retrieved_on BIGINT,
  source       VARCHAR
);
CREATE TABLE IF NOT EXISTS mentions (
  ticker      VARCHAR,
  thing_id    VARCHAR,
  thing_type  VARCHAR,
  created_utc BIGINT,
  author      VARCHAR,
  flair       VARCHAR,
  direction   VARCHAR,
  PRIMARY KEY (ticker, thing_id)
);
CREATE TABLE IF NOT EXISTS empirical_features (
  ticker          VARCHAR,
  window_start    BIGINT,
  mentions        INTEGER,
  authors         INTEGER,
  sov             DOUBLE,
  velocity        DOUBLE,
  accel           DOUBLE,
  z               DOUBLE,
  net_dir         DOUBLE,
  dd_count        INTEGER,
  flair_counts    VARCHAR,   -- JSON-encoded {flair: count}
  baseline_status VARCHAR,   -- cold | warming | ready
  h_e             DOUBLE,
  PRIMARY KEY (ticker, window_start)
);
CREATE TABLE IF NOT EXISTS market_bars (
  ticker VARCHAR, ts BIGINT, o DOUBLE, h DOUBLE, l DOUBLE, c DOUBLE,
  volume BIGINT, vwap DOUBLE, feed VARCHAR, as_of BIGINT,
  PRIMARY KEY (ticker, ts)
);
CREATE TABLE IF NOT EXISTS options_snapshot (
  ticker VARCHAR, ts BIGINT, call_vol BIGINT, put_vol BIGINT, pcr DOUBLE,
  call_oi BIGINT, put_oi BIGINT, atm_iv DOUBLE, iv_rank DOUBLE,
  breadth_strikes INTEGER, breadth_expiries INTEGER, feed VARCHAR, as_of BIGINT,
  PRIMARY KEY (ticker, ts)
);
CREATE TABLE IF NOT EXISTS analytical_features (
  ticker VARCHAR, window_start BIGINT, ret DOUBLE, rvol DOUBLE, rvol_conf VARCHAR,
  pcr DOUBLE, iv_rank DOUBLE, breadth INTEGER, h_m DOUBLE,
  PRIMARY KEY (ticker, window_start)
);
CREATE TABLE IF NOT EXISTS signals (
  ticker VARCHAR, window_start BIGINT, h_e DOUBLE, h_m DOUBLE, divergence DOUBLE,
  quadrant VARCHAR, rank INTEGER, rank_delta INTEGER, lead_lag_hrs DOUBLE,
  PRIMARY KEY (ticker, window_start)
);
CREATE TABLE IF NOT EXISTS baselines (
  ticker VARCHAR, how INTEGER, mention_mean DOUBLE, mention_std DOUBLE, vol_mean DOUBLE,
  PRIMARY KEY (ticker, how)
);
CREATE TABLE IF NOT EXISTS market_movers (
  ts BIGINT, kind VARCHAR, rank INTEGER, symbol VARCHAR,
  price DOUBLE, percent_change DOUBLE, volume BIGINT,
  PRIMARY KEY (ts, kind, rank)
);
CREATE TABLE IF NOT EXISTS ticker_names (
  symbol VARCHAR PRIMARY KEY,
  name   VARCHAR
);
"""

_RAW_POST_COLS = (
    "id, created_utc, author, title, selftext, link_flair_text, score, num_comments, retrieved_on, source"
)
_RAW_COMMENT_COLS = "id, created_utc, author, link_id, parent_id, body, score, retrieved_on, source"
_MENTION_COLS = "ticker, thing_id, thing_type, created_utc, author, flair, direction"


class DB:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.con = duckdb.connect(str(path))

    def init_schema(self) -> None:
        self.con.execute(SCHEMA)

    def close(self) -> None:
        self.con.close()

    # --- upserts (live re-fetch keeps the latest engagement snapshot) ---
    def upsert_posts(self, posts: list[RawPost]) -> None:
        if not posts:
            return
        self.con.executemany(
            f"""INSERT INTO raw_posts ({_RAW_POST_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT (id) DO UPDATE SET
                  score=excluded.score, num_comments=excluded.num_comments,
                  retrieved_on=excluded.retrieved_on""",
            [(p.id, p.created_utc, p.author, p.title, p.selftext, p.link_flair_text,
              p.score, p.num_comments, p.retrieved_on, p.source) for p in posts],
        )

    def upsert_comments(self, comments: list[RawComment]) -> None:
        if not comments:
            return
        self.con.executemany(
            f"""INSERT INTO raw_comments ({_RAW_COMMENT_COLS}) VALUES (?,?,?,?,?,?,?,?,?)
                ON CONFLICT (id) DO UPDATE SET
                  score=excluded.score, retrieved_on=excluded.retrieved_on""",
            [(c.id, c.created_utc, c.author, c.link_id, c.parent_id, c.body,
              c.score, c.retrieved_on, c.source) for c in comments],
        )

    def upsert_mentions(self, mentions: list[Mention]) -> None:
        if not mentions:
            return
        # Mention identity (ticker, thing_id) is fixed; keep first-seen.
        self.con.executemany(
            f"""INSERT INTO mentions ({_MENTION_COLS}) VALUES (?,?,?,?,?,?,?)
                ON CONFLICT (ticker, thing_id) DO NOTHING""",
            [(m.ticker, m.thing_id, m.thing_type, m.created_utc, m.author, m.flair, m.direction)
             for m in mentions],
        )

    def table_counts(self) -> dict[str, int]:
        out = {}
        for t in ("raw_posts", "raw_comments", "mentions"):
            out[t] = self.con.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
        return out

    # --- aggregator reads/writes (Phase 1) ---
    def mentions_in_window(self, start: int, end: int) -> list[tuple]:
        """(ticker, thing_id, thing_type, author, flair, direction) for [start, end)."""
        return self.con.execute(
            "SELECT ticker, thing_id, thing_type, author, flair, direction "
            "FROM mentions WHERE created_utc >= ? AND created_utc < ?",
            [start, end],
        ).fetchall()

    def features_at(self, window_start: int) -> dict[str, dict]:
        """Prior-window features by ticker — supplies mentions(W−1) and velocity(W−1)."""
        rows = self.con.execute(
            "SELECT ticker, mentions, velocity FROM empirical_features WHERE window_start = ?",
            [window_start],
        ).fetchall()
        return {r[0]: {"mentions": r[1], "velocity": r[2]} for r in rows}

    def feature_history(self, before: int) -> list[tuple]:
        """(ticker, window_start, mentions) for every window before `before` — baseline source."""
        return self.con.execute(
            "SELECT ticker, window_start, mentions FROM empirical_features WHERE window_start < ?",
            [before],
        ).fetchall()

    def sov_ranks_at(self, window_start: int) -> dict[str, int]:
        """Prior-window SoV rank by ticker (1 = top) — supplies rank_delta."""
        rows = self.con.execute(
            "SELECT ticker FROM empirical_features WHERE window_start = ? ORDER BY sov DESC",
            [window_start],
        ).fetchall()
        return {r[0]: i for i, r in enumerate(rows, 1)}

    def upsert_empirical_features(self, rows: list[EmpiricalFeature]) -> None:
        if not rows:
            return
        self.con.executemany(
            """INSERT INTO empirical_features
                 (ticker, window_start, mentions, authors, sov, velocity, accel, z,
                  net_dir, dd_count, flair_counts, baseline_status, h_e)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT (ticker, window_start) DO UPDATE SET
                 mentions=excluded.mentions, authors=excluded.authors, sov=excluded.sov,
                 velocity=excluded.velocity, accel=excluded.accel, z=excluded.z,
                 net_dir=excluded.net_dir, dd_count=excluded.dd_count,
                 flair_counts=excluded.flair_counts, baseline_status=excluded.baseline_status,
                 h_e=excluded.h_e""",
            [(r.ticker, r.window_start, r.mentions, r.authors, r.sov, r.velocity, r.accel, r.z,
              r.net_dir, r.dd_count, r.flair_counts, r.baseline_status, r.h_e) for r in rows],
        )

    def latest_window_start(self) -> int | None:
        row = self.con.execute("SELECT max(window_start) FROM empirical_features").fetchone()
        return row[0] if row and row[0] is not None else None

    # --- market overlay writes (Phase 2) ---
    def upsert_analytical_features(self, rows: list[AnalyticalFeature]) -> None:
        if not rows:
            return
        self.con.executemany(
            """INSERT INTO analytical_features
                 (ticker, window_start, ret, rvol, rvol_conf, pcr, iv_rank, breadth, h_m)
               VALUES (?,?,?,?,?,?,?,?,?)
               ON CONFLICT (ticker, window_start) DO UPDATE SET
                 ret=excluded.ret, rvol=excluded.rvol, rvol_conf=excluded.rvol_conf,
                 pcr=excluded.pcr, iv_rank=excluded.iv_rank, breadth=excluded.breadth,
                 h_m=excluded.h_m""",
            [(r.ticker, r.window_start, r.ret, r.rvol, r.rvol_conf, r.pcr, r.iv_rank, r.breadth, r.h_m)
             for r in rows],
        )

    def upsert_movers(self, movers: list[Mover]) -> None:
        if not movers:
            return
        self.con.executemany(
            """INSERT INTO market_movers (ts, kind, rank, symbol, price, percent_change, volume)
               VALUES (?,?,?,?,?,?,?)
               ON CONFLICT (ts, kind, rank) DO UPDATE SET
                 symbol=excluded.symbol, price=excluded.price,
                 percent_change=excluded.percent_change, volume=excluded.volume""",
            [(m.ts, m.kind, m.rank, m.symbol, m.price, m.percent_change, m.volume) for m in movers],
        )

    # --- ticker → company name (built from the Alpaca asset list, displayed everywhere) ---
    def upsert_ticker_names(self, pairs: list[tuple[str, str]]) -> None:
        if not pairs:
            return
        self.con.executemany(
            "INSERT INTO ticker_names (symbol, name) VALUES (?,?) "
            "ON CONFLICT (symbol) DO UPDATE SET name=excluded.name",
            [(s, n) for s, n in pairs],
        )

    def ticker_names(self) -> dict[str, str]:
        return {s: n for s, n in self.con.execute("SELECT symbol, name FROM ticker_names").fetchall()}

    # --- history export (Phase 3 time views) ---
    def export_history_parquet(self, path: Path) -> None:
        """Dump the full per-(ticker, hour) history to Parquet for the dashboard's time views.

        empirical_features is the spine; analytical (ret/rvol/H_m) is LEFT-joined and therefore
        NULL for ticker-hours that were never in the market top-N (sparse by design). The dashboard
        reads this file LOCK-FREE — the radar is the single DuckDB writer, so the dashboard must
        never open the DB itself (DuckDB takes an exclusive lock). `name_raw` is the unprettified
        Alpaca name (the dashboard applies pretty_name). DuckDB COPY-to-parquet needs no extra deps.
        """
        target = str(path).replace("'", "''")  # app-controlled path; escape quotes defensively
        self.con.execute(
            f"""COPY (
                  SELECT e.ticker, e.window_start, e.mentions, e.authors, e.sov,
                         e.velocity, e.accel, e.z, e.net_dir, e.dd_count, e.baseline_status, e.h_e,
                         a.ret, a.rvol, a.h_m, tn.name AS name_raw
                  FROM empirical_features e
                  LEFT JOIN analytical_features a USING (ticker, window_start)
                  LEFT JOIN ticker_names tn ON tn.symbol = e.ticker
                  ORDER BY e.window_start, e.ticker
                ) TO '{target}' (FORMAT PARQUET)"""
        )
