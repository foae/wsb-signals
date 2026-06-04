"""Typed records for the ingestion slice — mirror the DuckDB schema (db.py / architecture §2.7).

Only the empirical-path tables that the v0.0.1 poll writes are modelled here
(raw_posts, raw_comments, mentions). Market / feature / signal records arrive
with their phases (Phase 1–2); db.py already creates those tables.
"""
from __future__ import annotations

from pydantic import BaseModel


class RawPost(BaseModel):
    id: str
    created_utc: int
    author: str | None = None
    title: str | None = None
    selftext: str | None = None
    link_flair_text: str | None = None
    score: int | None = None
    num_comments: int | None = None
    retrieved_on: int
    source: str = "arctic_shift"

    @classmethod
    def from_arctic(cls, d: dict, retrieved_on: int) -> "RawPost":
        return cls(
            id=str(d.get("id")),
            created_utc=int(d.get("created_utc") or 0),
            author=d.get("author"),
            title=d.get("title"),
            selftext=d.get("selftext"),
            link_flair_text=d.get("link_flair_text"),
            score=d.get("score"),
            num_comments=d.get("num_comments"),
            retrieved_on=retrieved_on,
        )


class RawComment(BaseModel):
    id: str
    created_utc: int
    author: str | None = None
    link_id: str | None = None
    parent_id: str | None = None
    body: str | None = None
    score: int | None = None
    retrieved_on: int
    source: str = "arctic_shift"

    @classmethod
    def from_arctic(cls, d: dict, retrieved_on: int) -> "RawComment":
        return cls(
            id=str(d.get("id")),
            created_utc=int(d.get("created_utc") or 0),
            author=d.get("author"),
            link_id=d.get("link_id"),
            parent_id=d.get("parent_id"),
            body=d.get("body"),
            score=d.get("score"),
            retrieved_on=retrieved_on,
        )


class Mention(BaseModel):
    ticker: str
    thing_id: str
    thing_type: str               # 'post' | 'comment'
    created_utc: int
    author: str | None = None
    flair: str | None = None
    direction: str | None = None  # 'bull' | 'bear' | 'neutral' | None (classify.py)


class StockSnapshot(BaseModel):
    """A point-in-time stock snapshot from the market funnel (architecture §2.5)."""
    ticker: str
    price: float | None = None        # latest trade
    day_open: float | None = None
    day_close: float | None = None
    day_volume: int | None = None
    prev_close: float | None = None
    prev_volume: int | None = None
    feed: str = "iex"
    as_of: int | None = None


class Mover(BaseModel):
    """A screener row — market-wide most-active / gainer / loser (captured for STEALTH, v0.0.2)."""
    symbol: str
    kind: str                          # 'active' | 'gainer' | 'loser'
    rank: int
    price: float | None = None
    percent_change: float | None = None
    volume: int | None = None
    ts: int


class AnalyticalFeature(BaseModel):
    """A (ticker, window) market cell — Market Heat (signal-framework §3). v0.0.1: ret + rvol."""
    ticker: str
    window_start: int
    ret: float | None = None           # daily return (latest vs prev close)
    rvol: float | None = None          # day volume / prev-day volume (crude; low-conf on IEX)
    rvol_conf: str = "low"
    pcr: float | None = None           # put/call ratio — options increment
    iv_rank: float | None = None       # atm_iv / iv_rank — options increment
    breadth: int | None = None         # distinct active strikes — options increment
    h_m: float = 0.0                   # composite Market Heat


class EmpiricalFeature(BaseModel):
    """A (ticker, window) cell — the live empirical signal (signal-framework §2–§5)."""
    ticker: str
    window_start: int
    mentions: int
    authors: int
    sov: float                       # share of voice — PRIMARY ranker (§4)
    velocity: float | None = None    # Δmentions vs prior window; None when no prior window exists
    accel: float | None = None       # Δvelocity; None when velocity or its prior is undefined
    z: float | None = None           # vs hour-of-week baseline; None until baseline ready
    net_dir: float = 0.0             # (bull − bear)/(bull + bear) ∈ [−1, 1]
    dd_count: int = 0
    flair_counts: str = "{}"         # JSON {flair: count}
    baseline_status: str = "cold"    # cold | warming | ready
    h_e: float = 0.0                 # composite WSB Heat
