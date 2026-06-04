"""AlpacaMarketData — the free v0.0.1 market funnel impl (endpoints verified by probe_alpaca.py).

Stock snapshots (real-time IEX) → ret/rvol; screeners (most-actives + movers) → the one free
market-wide read, captured for STEALTH (v0.0.2). Options (pcr/iv/breadth) land in the next
increment. 200 calls/min; credentials sent as APCA-API-KEY-ID / APCA-API-SECRET-KEY headers.
"""
from __future__ import annotations

import time

import httpx

from ..log import get_logger
from ..models import Mover, StockSnapshot
from .base import MarketData

log = get_logger("wsb.alpaca")


class AlpacaMarketData(MarketData):
    name = "alpaca"

    def __init__(
        self,
        key: str,
        secret: str,
        *,
        data_url: str = "https://data.alpaca.markets",
        feed: str = "iex",
        user_agent: str = "wsb-signals/0.0.1",
        timeout: int = 30,
    ):
        self.feed = feed
        self.client = httpx.Client(
            base_url=data_url.rstrip("/"),
            headers={"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret, "User-Agent": user_agent},
            timeout=timeout,
        )

    def close(self) -> None:
        self.client.close()

    def snapshots(self, tickers: list[str]) -> dict[str, StockSnapshot]:
        if not tickers:
            return {}
        now = int(time.time())
        out: dict[str, StockSnapshot] = {}
        for i in range(0, len(tickers), 100):  # multi-symbol; chunk to stay within URL limits
            chunk = tickers[i : i + 100]
            r = self.client.get("/v2/stocks/snapshots", params={"symbols": ",".join(chunk), "feed": self.feed})
            if r.status_code != 200:
                log.warning("snapshots failed: status=%s %s", r.status_code, r.text[:140])
                continue
            for sym, s in r.json().items():
                lt = s.get("latestTrade") or {}
                db = s.get("dailyBar") or {}
                pdb = s.get("prevDailyBar") or {}
                out[sym] = StockSnapshot(
                    ticker=sym, price=lt.get("p"), day_open=db.get("o"), day_close=db.get("c"),
                    day_volume=db.get("v"), prev_close=pdb.get("c"), prev_volume=pdb.get("v"),
                    feed=self.feed, as_of=now,
                )
        return out

    def screeners(self, top: int = 25) -> list[Mover]:
        now = int(time.time())
        movers: list[Mover] = []

        r = self.client.get("/v1beta1/screener/stocks/most-actives", params={"top": top})
        if r.status_code == 200:
            for rank, a in enumerate(r.json().get("most_actives", []), 1):
                if a.get("symbol"):
                    movers.append(Mover(symbol=a["symbol"], kind="active", rank=rank,
                                        volume=a.get("volume"), ts=now))
        else:
            log.warning("most-actives failed: status=%s %s", r.status_code, r.text[:120])

        r = self.client.get("/v1beta1/screener/stocks/movers", params={"top": top})
        if r.status_code == 200:
            d = r.json()
            for kind, key in (("gainer", "gainers"), ("loser", "losers")):
                for rank, m in enumerate(d.get(key, []), 1):
                    if m.get("symbol"):
                        movers.append(Mover(symbol=m["symbol"], kind=kind, rank=rank,
                                            price=m.get("price"), percent_change=m.get("percent_change"), ts=now))
        else:
            log.warning("movers failed: status=%s %s", r.status_code, r.text[:120])

        return movers
