"""Extractor precision tests — the foundation of every empirical signal.

Covers the decision precedence (cashtag > too_short > stop > not_listed > ambiguous-gate >
accept) and especially the DRAM-class ambiguous-word gate: a real ticker that is also a common
word is counted only with trading context or an explicit $-cashtag.
"""
from wsb_signals.extract import TickerExtractor, has_trading_context


def _ex(stop=(), whitelist=None, ambiguous=()):
    return TickerExtractor(
        set(stop),
        whitelist=(set(whitelist) if whitelist is not None else None),
        ambiguous=set(ambiguous),
    )


def test_has_trading_context():
    assert has_trading_context("loaded up on calls") is True
    assert has_trading_context("grabbed some $SPY") is True          # $ alone qualifies
    assert has_trading_context("i need more dram for my pc") is False
    assert has_trading_context("") is False
    assert has_trading_context(None) is False


def test_cashtag_overrides_stoplist():
    ex = _ex(stop={"CEO"})
    assert ex.extract("our CEO is great") == []                      # bare → stop
    assert ex.extract("$CEO to the moon") == ["CEO"]                 # cashtag bypasses stop


def test_bare_single_letter_dropped_cashtag_kept():
    ex = _ex(whitelist={"F", "T"})
    assert ex.extract("F was bad") == []                             # bare single letter → too_short
    assert ex.extract("$F calls") == ["F"]                           # cashtag admits single letter


def test_whitelist_filters_unlisted():
    ex = _ex(whitelist={"NVDA"})
    assert ex.extract("ZZZZ mooning") == []                          # not in whitelist → dropped
    assert ex.extract("NVDA mooning") == ["NVDA"]


def test_ambiguous_word_requires_trading_context():
    # DRAM is a real ETF ticker AND the word for memory chips. Whitelisted, but gated.
    ex = _ex(whitelist={"DRAM", "NVDA"}, ambiguous={"DRAM"})
    assert ex.extract("need more DRAM for my new PC build") == []    # no trading word → gated out
    assert ex.extract("bought DRAM calls this morning") == ["DRAM"]  # trading context → admitted
    assert ex.extract("$DRAM") == ["DRAM"]                           # cashtag always overrides
    # A non-ambiguous whitelisted ticker is unaffected by the gate.
    assert ex.extract("NVDA") == ["NVDA"]


def test_ambiguous_decision_codes():
    ex = _ex(whitelist={"DRAM"}, ambiguous={"DRAM"})
    assert ex.classify("just DRAM") == [("DRAM", "ambig_no_context")]
    assert ex.classify("DRAM puts") == [("DRAM", "whitelist_ok")]
