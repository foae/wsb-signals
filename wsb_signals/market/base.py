"""The MarketData funnel interface (architecture §2.5) — one abstraction over providers.

AlpacaMarketData is the free v0.0.1 impl. Massive (paid, full-market) / IBKR slot in behind the
same interface without reworking callers. Market data is gated to the WSB-hot leaderboard; the
screeners are the one market-wide read (free) — captured for STEALTH (v0.0.2).
"""
from __future__ import annotations

from abc import ABC, abstractmethod

from ..models import Mover, StockSnapshot


class MarketData(ABC):
    name: str = "market"

    @abstractmethod
    def snapshots(self, tickers: list[str]) -> dict[str, StockSnapshot]:
        """Latest price/volume per ticker (gated to the WSB-hot list)."""

    @abstractmethod
    def screeners(self, top: int) -> list[Mover]:
        """Market-wide most-actives + movers (the one free market-wide read)."""

    def option_summary(self, underlying: str):
        raise NotImplementedError(f"{self.name}: option_summary (pcr/iv/breadth) — options increment")

    def close(self) -> None:
        """Release any held client. Default: no-op."""
