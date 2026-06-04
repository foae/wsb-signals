"""Direction classifier (architecture §2.3) — bull/bear from options/position language.

WSB lexical sentiment is ironic/inverted, so *direction* (calls/puts, long/short, bought/sold)
is the reliable signal, not generic positivity. v0.0.1 classifies at the thing (post/comment)
level and attaches the same direction to every ticker in that thing — crude for multi-ticker
posts ("long NVDA short AMD"); a per-mention windowed classifier is a later refinement.
"""
from __future__ import annotations

import re

BULL = {
    "call", "calls", "long", "buy", "buying", "bought", "bull", "bullish", "moon", "mooning",
    "rocket", "rockets", "loading", "loaded", "leaps", "upside", "squeeze", "yolo", "tendies",
}
BEAR = {
    "put", "puts", "short", "shorting", "shorted", "sell", "selling", "sold", "bear", "bearish",
    "drill", "drilling", "downside", "crash", "crashing", "tank", "tanking", "hedge", "dump",
}

_WORD = re.compile(r"[a-z']+")


def direction(text: str | None) -> str:
    """Return 'bull' | 'bear' | 'neutral' from directional token balance."""
    if not text:
        return "neutral"
    toks = _WORD.findall(text.lower())
    bull = sum(t in BULL for t in toks)
    bear = sum(t in BEAR for t in toks)
    if bull > bear:
        return "bull"
    if bear > bull:
        return "bear"
    return "neutral"
