"""ArcticShiftSource — the thin in-house httpx client for the sole live tap.

Paginated descending poll over /{posts,comments}/search for one subreddit, walking
the `before` cursor back to the window cutoff. Honours X-RateLimit-* headers. Logic
ported from the proven scripts/e2e_top5.py PoC. Arctic-Shift content is ~real-time;
engagement (score/num_comments) lags ~36 h, so those are post-hoc only (Phase 4).
"""
from __future__ import annotations

import time

import httpx

from ..log import get_logger
from ..models import RawComment, RawPost
from .base import PollResult, Source

log = get_logger("wsb.arctic")


class ArcticShiftSource(Source):
    name = "arctic_shift"

    def __init__(
        self,
        base_url: str,
        subreddit: str,
        *,
        page_limit: int = 100,
        max_pages: int = 60,
        user_agent: str = "wsb-signals/0.0.1",
        timeout: int = 60,
    ):
        self.subreddit = subreddit
        self.page_limit = page_limit
        self.max_pages = max_pages
        self.client = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers={"User-Agent": user_agent},
            timeout=timeout,
        )

    def close(self) -> None:
        self.client.close()

    def _respect_ratelimit(self, resp: httpx.Response) -> None:
        rem = resp.headers.get("X-RateLimit-Remaining")
        if rem is None:
            return
        try:
            if int(rem) < 50:
                log.info("rate-limit low (remaining=%s) — backing off 2s", rem)
                time.sleep(2)
        except ValueError:
            pass

    def _fetch(self, kind: str, cutoff: int, now: int) -> tuple[list[dict], bool, bool]:
        """Walk pages from `now` back to `cutoff`; return (items_in_window, capped, ok).

        `ok` is False if a request errored or returned a non-200/non-JSON page mid-walk:
        the result is then partial and must NOT be treated as a complete window (it would
        silently undercount the SoV denominator). `capped` flags the separate, benign case
        of hitting the page cap on a window that genuinely has more items than max_pages.
        """
        items: list[dict] = []
        before = now + 5
        capped = False
        ok = True
        for _ in range(self.max_pages):
            try:
                resp = self.client.get(
                    f"/{kind}/search",
                    params={
                        "subreddit": self.subreddit,
                        "limit": self.page_limit,
                        "sort": "desc",
                        "after": cutoff,
                        "before": before,
                    },
                )
            except httpx.HTTPError as e:
                log.warning("%s page request failed: %s — poll is partial this cycle", kind, e)
                ok = False
                break
            if resp.status_code != 200:
                log.warning("%s page failed: status=%s %s — poll is partial this cycle",
                            kind, resp.status_code, resp.text[:140])
                ok = False
                break
            self._respect_ratelimit(resp)
            try:
                data = resp.json().get("data", [])
            except ValueError:
                log.warning("%s page returned a non-JSON body — poll is partial this cycle", kind)
                ok = False
                break
            if not data:
                break
            items += data
            oldest = min(x.get("created_utc", now) for x in data)
            if oldest <= cutoff or len(data) < self.page_limit:  # reached window start or exhausted
                break
            before = oldest
            time.sleep(0.3)
        else:  # loop ran all max_pages without breaking → truncated
            capped = True
        in_window = [x for x in items if x.get("created_utc", 0) >= cutoff]
        return in_window, capped, ok

    def poll(self, window_seconds: int) -> PollResult:
        now = int(time.time())
        cutoff = now - window_seconds
        raw_posts, pcap, pok = self._fetch("posts", cutoff, now)
        raw_comments, ccap, cok = self._fetch("comments", cutoff, now)
        posts = [RawPost.from_arctic(d, now) for d in raw_posts]
        comments = [RawComment.from_arctic(d, now) for d in raw_comments]

        times = [p.created_utc for p in posts] + [c.created_utc for c in comments]
        newest = max(times) if times else None
        capped = pcap or ccap
        if capped:
            log.warning(
                "hit %d-page cap — window likely undercounted (raise ingest.max_pages); "
                "this biases sov denominators (architecture §3 throughput caveat)",
                self.max_pages,
            )
        return PollResult(posts=posts, comments=comments, newest_utc=newest, capped=capped, ok=pok and cok)

    def newest_item_lag(self, kind: str = "comments") -> float | None:
        """Seconds between now and the freshest archived item — the Phase-0.5 heartbeat probe.

        None if the tap errors or returns nothing (caller treats that as 'down').
        """
        resp = self.client.get(
            f"/{kind}/search",
            params={"subreddit": self.subreddit, "limit": 1, "sort": "desc"},
        )
        if resp.status_code != 200:
            log.warning("heartbeat %s probe failed: status=%s", kind, resp.status_code)
            return None
        data = resp.json().get("data", [])
        if not data:
            return None
        newest = max(x.get("created_utc", 0) for x in data)
        return int(time.time()) - newest
