#!/usr/bin/env python3
"""Live-shadow REPLAY — run the FROZEN v0.0.1 oracle over the TS worker's captured live inputs (slice 9).

The TS worker, run with `--shadow`, dumps one `cycle-<window_start>.json` per cycle (packages/worker/
src/shadow.ts): the raw poll, the assembled mentions (B3), the EXACT reads its scorer consumed, and the
board it produced (B4). This script feeds those SAME captured inputs through the frozen Python oracle and
emits the oracle's B3+B4 truth in the identical wire shape. Because both pipelines see byte-identical
input, the downstream `shadow-diff` is a DETERMINISTIC value+order parity check — any divergence is a real
port bug, not the input noise two independent live polls would produce (v2-porting-spec §9, §1).

This is strictly stronger than the committed golden fixtures: it runs the parity contract continuously
against whatever real-world ticker / flair / author / unicode shapes the live firehose actually produces.

Run (from repo root, in the v0.0.1 env), after a `--shadow` worker run:
    uv run python oracle/replay.py [tsDir=data/shadow] [oracleDir=data/shadow-oracle]
Then gate:  pnpm -C packages/worker shadow-diff data/shadow data/shadow-oracle

NOTE: B3 (mention) parity needs the SAME wordsets the worker used — run replay against the same repo
state (especially the derived whitelist/symbols.txt). B4 (scoring) parity is wordset-independent: it
replays the captured mention rows directly, so it holds regardless.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))  # import the frozen package in-place (no install needed)

from wsb_signals.aggregate import aggregate_window  # noqa: E402
from wsb_signals.cli import _build_extractor, _mentions_from_poll  # noqa: E402
from wsb_signals.config import Settings  # noqa: E402
from wsb_signals.models import RawComment, RawPost  # noqa: E402
from wsb_signals.sources.base import PollResult  # noqa: E402

SCHEMA_VERSION = 1


def fnv1a(s: str) -> int:
    """FNV-1a 32-bit — byte-identical to shadow.ts `fnv1a` (which uses Math.imul for the prime multiply)."""
    h = 0x811C9DC5
    for ch in s:
        h = ((h ^ ord(ch)) * 0x01000193) & 0xFFFFFFFF
    return h


def fingerprint_wordset(words) -> dict:
    """Size + FNV-1a over the code-point-sorted symbols joined by '\\n' — matches shadow.fingerprintWordset
    (JS default sort = code-unit order; ASCII tickers sort identically to Python's `sorted`)."""
    sorted_words = sorted(words)
    return {"n": len(sorted_words), "fnv": fnv1a("\n".join(sorted_words))}


def fingerprint_extractor(extractor) -> dict:
    """Fingerprint the extractor's three wordsets — matches shadow.fingerprintExtractor."""
    wl = extractor.whitelist
    return {
        "whitelist": fingerprint_wordset(wl) if wl is not None else None,
        "stoplist": fingerprint_wordset(extractor.stop),
        "ambiguous": fingerprint_wordset(extractor.ambiguous),
    }


def canonical(obj) -> str:
    """Deterministic JSON: sorted keys, UTF-8, trailing newline — matches shadow.ts `canonicalJson`
    (the diff parses numbers, so the on-disk float repr need not match byte-for-byte; this is for humans
    + stable git diffs)."""
    return json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


class _FakeDB:
    """Duck-typed stand-in for `wsb_signals.db.DB`, exposing ONLY the four reads `aggregate_window` calls.
    Each returns the worker-captured input verbatim (args ignored — the capture was taken at exactly these
    call sites), so the frozen scorer runs over byte-identical inputs without a DuckDB."""

    def __init__(self, inp: dict):
        # mentions_in_window rows: [ticker, thing_id, thing_type, author, flair, direction] (as tuples).
        self._mentions = [tuple(r) for r in inp["mentions_in_window"]]
        # features_at: {ticker: {"mentions": int, "velocity": float|None}}
        self._prior = inp["prior_features"]
        # sov_ranks_at: {ticker: int}
        self._ranks = inp["prior_sov_ranks"]
        # feature_history: [ticker, window_start, mentions] (as tuples).
        self._history = [tuple(r) for r in inp["feature_history"]]

    def mentions_in_window(self, start: int, end: int):  # noqa: ARG002
        return self._mentions

    def features_at(self, window_start: int):  # noqa: ARG002
        return self._prior

    def sov_ranks_at(self, window_start: int):  # noqa: ARG002
        return self._ranks

    def feature_history(self, before: int):  # noqa: ARG002
        return self._history


def replay_features(dump: dict) -> list[dict]:
    """B4 — drive the frozen `aggregate_window` over the captured inputs → wire features (canonical order)."""
    inp = dump["inputs"]
    rows = aggregate_window(
        _FakeDB(inp),  # type: ignore[arg-type]  # duck-typed: only the four reads aggregate_window calls
        inp["window_start"],
        inp["window_seconds"],
        weights=inp["weights"],
        min_samples_ready=inp["min_samples_ready"],
        min_authors_full=inp["min_authors_full"],
    )
    out = []
    for r in rows:
        d = r.model_dump()
        # The oracle stores flair_counts as a canonical JSON STRING; the wire form is an OBJECT (the diff
        # compares counts, not serialization — aggregate.ts NOTE / porting-spec §2.6).
        d["flair_counts"] = json.loads(d["flair_counts"]) if d.get("flair_counts") else {}
        out.append(d)
    return out


def replay_mentions(dump: dict, extractor, bots: set) -> list[dict]:
    """B3 — rebuild the poll and re-run the frozen `_mentions_from_poll` → wire mentions (sorted by
    thing_id, ticker, the B3 boundary). Tests extraction/classification on the real captured text."""
    posts = [RawPost(**p) for p in dump["poll"]["posts"]]
    comments = [RawComment(**c) for c in dump["poll"]["comments"]]
    res = PollResult(posts=posts, comments=comments)
    mentions, _counts, _authors = _mentions_from_poll(res, extractor, bots)
    rows = [m.model_dump() for m in mentions]
    rows.sort(key=lambda m: (m["thing_id"], m["ticker"]))
    return rows


def main() -> None:
    args = sys.argv[1:]
    ts_dir = Path(args[0]) if len(args) > 0 else REPO / "data" / "shadow"
    oracle_dir = Path(args[1]) if len(args) > 1 else REPO / "data" / "shadow-oracle"
    if not ts_dir.is_dir():
        sys.exit(f"replay: tsDir not found: {ts_dir}")
    oracle_dir.mkdir(parents=True, exist_ok=True)

    # Build the extractor + bots EXACTLY as `wsb run` would (mirrors the worker's buildExtractor; both
    # fail-closed identically off the same committed files), so B3 parity is apples-to-apples.
    settings = Settings.load(REPO)
    extractor = _build_extractor(settings)
    bots = set(settings.extract["bots"])

    # B3 parity needs both sides on the SAME whitelist. `_build_extractor` already WARNS if symbols.txt is
    # missing (→ cashtag-only empty set); both worker and replay fail-closed identically, so parity holds
    # either way. Report the state the oracle's own `eval-extractor` uses: ON (N symbols) vs OFF (None).
    wl = extractor.whitelist
    wl_state = f"ON ({len(wl)} symbols)" if wl is not None else "OFF (no whitelist)"
    our_fp = fingerprint_extractor(extractor)  # this replay's wordlists — compared to each dump's
    cycles = sorted(p for p in ts_dir.glob("cycle-*.json"))
    print(f"replay: {len(cycles)} cycle(s) {ts_dir} → {oracle_dir}  (whitelist: {wl_state})")
    mismatches = 0
    for path in cycles:
        dump = json.loads(path.read_text())
        if dump.get("schema_version") != SCHEMA_VERSION:
            print(f"  ⚠ skip {path.name}: schema_version {dump.get('schema_version')} != {SCHEMA_VERSION}")
            continue
        # B3 parity premise: replay's wordlists == the worker's. `wordset_match` lets shadow-diff attribute
        # any B3 mention diff to a stale symbols.txt (a SETUP error) rather than a port bug. None = the dump
        # predates the fingerprint (can't tell).
        dump_fp = dump.get("wordsets")
        wordset_match = (dump_fp == our_fp) if dump_fp is not None else None
        if wordset_match is False:
            mismatches += 1
        out = {
            "schema_version": SCHEMA_VERSION,
            "window_start": dump["window_start"],
            "features": replay_features(dump),
            "mentions": replay_mentions(dump, extractor, bots),
            "wordset_match": wordset_match,
        }
        (oracle_dir / path.name).write_text(canonical(out))
    if mismatches:
        print(f"  ⚠ {mismatches} cycle(s) had a WORDSET MISMATCH — replay's wordlists differ from the worker's "
              f"(stale/derived symbols.txt?). B4 parity is unaffected; B3 mention diffs are a SETUP error.")
    print("done.")


if __name__ == "__main__":
    main()
