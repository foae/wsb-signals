"""The Source interface — one abstraction over Reddit taps (architecture §2.1).

ArcticShiftSource is the live impl. PullPush (dormant), Discord (deferred), and a
Reddit-API break-glass slot in behind the same interface without reworking callers.
backfill/search are declared but raise NotImplementedError until their phase.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from ..models import RawComment, RawPost


@dataclass
class PollResult:
    posts: list[RawPost] = field(default_factory=list)
    comments: list[RawComment] = field(default_factory=list)
    newest_utc: int | None = None   # freshest item seen — feeds the Phase-0.5 heartbeat
    capped: bool = False            # True if pagination hit the page cap (window undercounted)
    ok: bool = True                 # False if a fetch errored mid-pagination (partial, undercounted)


class Source(ABC):
    name: str = "source"

    @abstractmethod
    def poll(self, window_seconds: int) -> PollResult:
        """Fetch posts + comments created within the trailing `window_seconds`."""

    def backfill(self, start_utc: int, end_utc: int) -> PollResult:
        raise NotImplementedError(f"{self.name}: backfill is a Phase-4 capability")

    def search(self, query: str, **kwargs) -> PollResult:
        raise NotImplementedError(f"{self.name}: search not implemented")

    def close(self) -> None:
        """Release any held client/connection. Default: no-op."""
