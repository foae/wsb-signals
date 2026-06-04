"""Ticker extractor — candidate regex + stoplist (+ optional whitelist + ambiguous gate).

Ported from scripts/e2e_top5.py and made configurable. The extractor is the
foundation of every empirical signal, so precision matters:
  - a $-cashtag ($NVDA) is high-confidence and overrides the stoplist AND the
    ambiguous gate;
  - bare uppercase tokens are dropped if they hit the stoplist or (when a
    whitelist is loaded) aren't known listed symbols;
  - AMBIGUOUS tokens (real tickers that are also common words, e.g. DRAM) are
    accepted only when the surrounding text carries TRADING CONTEXT — otherwise
    "DRAM" the memory chip would be miscounted as the Roundhill Memory ETF.
Whitelist wiring + a precision/recall eval are Phase 0.4 (architecture §2.2).
"""
from __future__ import annotations

import re
from pathlib import Path

# Optional $-cashtag + 1–5 uppercase letters. Single-letter tokens are matched only so
# classify() can ACCEPT them when $-prefixed ($F, $T) and DROP them when bare — see
# architecture.md §2.2 ("bare 1-char tokens only via an explicit $-cashtag").
DEFAULT_REGEX = r"(?<![A-Za-z0-9])(\$)?([A-Z]{1,5})(?![A-Za-z0-9])"

# Options / position vocabulary. A token co-occurring with any of these (or a $) sits in
# trading context — the cheap proxy used to (a) admit AMBIGUOUS word-tickers here and
# (b) measure the co-occurrence rate in `wsb eval-extractor` (architecture §2.2).
TRADING_WORDS = frozenset({
    "call", "calls", "put", "puts", "strike", "strikes", "expiry", "expiration", "leaps",
    "contracts", "contract", "premium", "otm", "itm", "atm", "theta", "gamma", "delta", "vega",
    "long", "short", "shares", "bought", "sold", "buy", "sell", "position", "earnings",
    "squeeze", "bullish", "bearish", "moon", "yolo",
})

_CTX_WORD = re.compile(r"[a-z]+")


def has_trading_context(text: str | None) -> bool:
    """True if the text carries options/position language (or a $) — the §2.2 co-occurrence proxy."""
    if not text:
        return False
    if "$" in text:
        return True
    return any(t in TRADING_WORDS for t in _CTX_WORD.findall(text.lower()))


class TickerExtractor:
    def __init__(
        self,
        stoplist: set[str],
        *,
        regex: str = DEFAULT_REGEX,
        whitelist: set[str] | None = None,
        ambiguous: set[str] | None = None,
    ):
        self.stop = stoplist
        self.re = re.compile(regex)
        self.whitelist = whitelist  # None = accept any non-stop candidate (no whitelist yet)
        self.ambiguous = ambiguous or set()  # word-tickers gated on trading context

    @classmethod
    def from_files(
        cls,
        stoplist_path: Path,
        *,
        regex: str = DEFAULT_REGEX,
        whitelist_path: Path | None = None,
        ambiguous_path: Path | None = None,
    ) -> "TickerExtractor":
        stop = _load_wordset(stoplist_path)
        wl = _load_wordset(whitelist_path) if whitelist_path else None
        amb = _load_wordset(ambiguous_path) if ambiguous_path else None
        return cls(stop, regex=regex, whitelist=wl, ambiguous=amb)

    @classmethod
    def cashtag_only(cls, stoplist_path: Path, *, regex: str = DEFAULT_REGEX) -> "TickerExtractor":
        """Fail-closed fallback when the whitelist is configured but missing: an EMPTY whitelist
        rejects every bare token (`not_listed`), so only high-confidence $-cashtags are accepted."""
        return cls(_load_wordset(stoplist_path), regex=regex, whitelist=set())

    # Decision codes from classify(); accepted = cashtag / whitelist_ok / open_ok.
    ACCEPT = ("cashtag", "whitelist_ok", "open_ok")

    def classify(self, text: str | None) -> list[tuple[str, str]]:
        """Per candidate token, return (symbol, decision). Shared by extract() and the eval.

        Decisions: cashtag | too_short | stop | not_listed | ambig_no_context | whitelist_ok | open_ok.
        An ambiguous word-ticker without a $-cashtag is admitted only when the text as a whole
        carries trading context (computed once per text, not per token).
        """
        out: list[tuple[str, str]] = []
        # Only pay for the context scan when this text actually has an ambiguous candidate.
        ctx: bool | None = None
        for m in self.re.finditer(text or ""):
            cash, sym = m.group(1), m.group(2)
            if cash:
                d = "cashtag"        # $-cashtag: high confidence, bypasses stop / whitelist / ambiguous
            elif len(sym) < 2:
                d = "too_short"      # bare single letter (e.g. "F") — too noisy without a cashtag
            elif sym in self.stop:
                d = "stop"           # common word / usually-not-a-ticker (even if also listed)
            elif self.whitelist is not None and sym not in self.whitelist:
                d = "not_listed"     # not a real listed symbol → drop
            elif sym in self.ambiguous:
                if ctx is None:
                    ctx = has_trading_context(text)
                d = ("whitelist_ok" if self.whitelist is not None else "open_ok") if ctx else "ambig_no_context"
            else:
                d = "whitelist_ok" if self.whitelist is not None else "open_ok"
            out.append((sym, d))
        return out

    def extract(self, text: str | None) -> list[str]:
        return [sym for sym, d in self.classify(text) if d in self.ACCEPT]


def _load_wordset(path: Path) -> set[str]:
    words: set[str] = set()
    for line in Path(path).read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            words.update(line.split())
    return words
