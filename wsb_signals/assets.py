"""Build the ticker whitelist from Alpaca's asset universe (Phase 0.4).

The extractor validates bare candidate tokens against this set, so we keep only
*listed, tradable* US equities/ETFs and drop OTC pink-sheets (they add ~1k
regex-matching junk symbols). A $-cashtag bypasses the whitelist, and the stoplist
still overrides common-word tickers (ALL, DD, IT). Refresh weekly (architecture §2.2).
"""
from __future__ import annotations

from pathlib import Path

import httpx

from .log import get_logger

log = get_logger("wsb.assets")


def fetch_alpaca_assets(
    key: str,
    secret: str,
    *,
    endpoint_url: str,
    user_agent: str = "wsb-signals/0.0.1",
    include_otc: bool = False,
    timeout: int = 60,
) -> list[tuple[str, str]]:
    """Active, tradable us_equity (symbol, name) pairs from /v2/assets (sorted, deduped by symbol)."""
    resp = httpx.get(
        endpoint_url.rstrip("/") + "/assets",
        params={"status": "active", "asset_class": "us_equity"},
        headers={"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret, "User-Agent": user_agent},
        timeout=timeout,
    )
    resp.raise_for_status()
    by_sym: dict[str, str] = {}
    for a in resp.json():
        if not a.get("tradable"):
            continue
        if not include_otc and a.get("exchange") == "OTC":
            continue
        sym = (a.get("symbol") or "").strip()
        if sym and sym not in by_sym:
            by_sym[sym] = (a.get("name") or "").strip()
    return sorted(by_sym.items())


def build_whitelist(
    key: str,
    secret: str,
    *,
    endpoint_url: str,
    out_path: Path,
    user_agent: str = "wsb-signals/0.0.1",
    include_otc: bool = False,
) -> list[tuple[str, str]]:
    """Fetch the universe, write symbols to `out_path`, and return the (symbol, name) pairs.

    The caller persists the names to the `ticker_names` DuckDB table (displayed everywhere).
    """
    assets = fetch_alpaca_assets(
        key, secret, endpoint_url=endpoint_url, user_agent=user_agent, include_otc=include_otc
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    header = (
        "# Ticker whitelist — Alpaca active, tradable us_equity"
        + ("" if include_otc else " (non-OTC)")
        + ".\n"
        "# DERIVED + refreshable, gitignored. Regenerate weekly: `wsb build-whitelist`.\n"
        "# One symbol per line; company names live in the ticker_names DuckDB table. See architecture §2.2.\n"
    )
    out_path.write_text(header + "\n".join(s for s, _ in assets) + "\n")
    return assets
