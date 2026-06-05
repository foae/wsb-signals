#!/usr/bin/env python3
"""Oracle dump-harness — emit golden parity fixtures from the FROZEN v0.0.1 radar.

This script imports the frozen `wsb_signals` pipeline (the parity oracle, `git tag v0.0.1`) and runs
deterministic, hand-built scenarios through it, dumping canonical JSON at the parity boundaries the TS
port asserts against (v2-porting-spec.md §1):

  - B3 extract/classify : text → [(symbol, decision)] + extract() + direction()   → fixtures/extract_classify.json
  - B4 aggregate H_e    : (mentions-in-window + prior state + config) → EmpiricalFeature[]
  - B5 snapshot         : write_snapshot() payload (the leaderboard.json contract)  → fixtures/aggregate/*.json

Design: each aggregate fixture carries BOTH the exact inputs the frozen `aggregate_window` consumed
(captured by calling the real db read methods) AND its outputs, so the TS test feeds the inputs to the
TS port and diffs the outputs WITHOUT needing DuckDB or Python at test time (parity at the object/JSON
boundary, never DB rows — the oracle writes DuckDB, the port writes Postgres).

Run (from repo root, in the v0.0.1 env):  uv run python oracle/dump_fixtures.py
Regenerate whenever the frozen oracle is re-pinned; the emitted fixtures/ are COMMITTED (the contract).
"""
from __future__ import annotations

import json
import random
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))  # import the frozen package in-place (no install needed)

from wsb_signals.aggregate import aggregate_window, hour_of_week, write_snapshot  # noqa: E402
from wsb_signals.classify import direction  # noqa: E402
from wsb_signals.db import DB  # noqa: E402
from wsb_signals.extract import DEFAULT_REGEX, TickerExtractor, _load_wordset  # noqa: E402
from wsb_signals.models import EmpiricalFeature, Mention  # noqa: E402

FIXTURES = REPO / "fixtures"


def canonical(obj) -> str:
    """Deterministic JSON: sorted keys, UTF-8, trailing newline. Floats are full-precision (the TS
    parity test compares numerics within tolerance; structure/strings/ints must match exactly)."""
    return json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def write_fixture(rel: str, obj) -> None:
    path = FIXTURES / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(canonical(obj))
    print(f"  wrote {path.relative_to(REPO)}")


def load_config() -> dict:
    """The exact tunables the fixtures are computed with (single source = the committed config.toml)."""
    cfg = tomllib.loads((REPO / "config.toml").read_text())
    return {
        "window_seconds": cfg["ingest"]["window_seconds"],
        "weights": cfg["heat"]["weights"],
        "min_authors_full": cfg["heat"]["min_authors_full"],
        "min_window_mentions": cfg["heat"]["min_window_mentions"],
        "min_samples_ready": cfg["baseline"]["min_samples_ready"],
    }


# --------------------------------------------------------------------------------------------------
# B3 — extract / classify (slice 1, pure). Small embedded wordsets exercise every decision branch;
# full-wordlist parity (the committed stoplist.txt/ambiguous.txt loader) is a separate slice-1 test.
# --------------------------------------------------------------------------------------------------
WORDSETS = {
    # Common words / abbreviations that are also uppercase tokens (bare → dropped; $-cashtag overrides).
    "stoplist": ["A", "ALL", "AND", "CEO", "DD", "FD", "I", "IMO", "IN", "THE", "USA", "YOLO"],
    # A fixed, small "listed universe". Single letters (F, T) are reachable only via $-cashtag.
    "whitelist": ["AMC", "AMD", "BABA", "DRAM", "F", "GME", "NVDA", "ON", "PLTR", "SO", "T", "TSLA"],
    # Real tickers that are also common words — admitted only with trading context (or a $-cashtag).
    "ambiguous": ["ALL", "ANY", "DRAM", "IT", "ON", "OPEN", "REAL", "SO"],
}

# (id, mode, text) — mode "whitelist" loads the whitelist; "open" runs with whitelist=None.
EC_CASES = [
    ("cashtag_overrides_too_short", "whitelist", "I bought $NVDA calls"),
    ("bare_whitelist_ok_bull", "whitelist", "NVDA to the moon"),
    ("ambiguous_no_context", "whitelist", "DRAM prices are rising"),
    ("ambiguous_with_context", "whitelist", "DRAM calls printing"),
    ("cashtag_overrides_ambiguous", "whitelist", "$DRAM is memory"),
    ("stop_bare_dd_but_cashtag_ok", "whitelist", "DD on $GME"),
    ("not_listed_and_too_short", "whitelist", "BUY F and T shares"),
    ("single_letters_via_cashtag", "whitelist", "$F $T leaps"),
    ("stop_notlisted_ambig_mix", "whitelist", "ALL IN ON SOFI"),
    ("multi_ticker_bearish", "whitelist", "puts on TSLA, short AMD"),
    ("open_mode_ambiguous_context", "open", "DRAM moon"),
    ("open_mode_unknown_and_six_letter_boundary", "open", "RANDOM ticker XYZ"),
]


def dump_extract_classify() -> None:
    print("extract/classify (B3):")
    stop = set(WORDSETS["stoplist"])
    wl = set(WORDSETS["whitelist"])
    amb = set(WORDSETS["ambiguous"])
    ext_wl = TickerExtractor(stop, regex=DEFAULT_REGEX, whitelist=wl, ambiguous=amb)
    ext_open = TickerExtractor(stop, regex=DEFAULT_REGEX, whitelist=None, ambiguous=amb)

    cases = []
    for cid, mode, text in EC_CASES:
        ext = ext_wl if mode == "whitelist" else ext_open
        cases.append({
            "id": cid,
            "mode": mode,
            "text": text,
            "classify": [[sym, dec] for sym, dec in ext.classify(text)],
            "extract": ext.extract(text),
            "direction": direction(text),
        })
    write_fixture("extract_classify.json", {
        "regex": DEFAULT_REGEX,
        "wordsets": WORDSETS,
        "cases": cases,
    })


def dump_wordset_loader() -> None:
    """Loader parity on the REAL committed wordlists — `_load_wordset` strips `#`-comments, splits on
    any whitespace, dedups. The TS loader must parse these identical files to the identical set
    (symbols.txt is derived/gitignored, so it's out of scope here)."""
    print("wordset loader (B3 — real committed files):")
    out = {}
    for key, rel in (("stoplist", "whitelist/stoplist.txt"), ("ambiguous", "whitelist/ambiguous.txt")):
        toks = sorted(_load_wordset(REPO / rel))
        out[key] = {"path": rel, "count": len(toks), "tokens": toks}
    write_fixture("wordset_loader.json", out)


# --------------------------------------------------------------------------------------------------
# B4/B5 — aggregate H_e + snapshot (slice 2). Build a temp DuckDB, seed prior/baseline features and the
# window's mentions, capture the exact reads `aggregate_window` consumes, then run it + write_snapshot.
# --------------------------------------------------------------------------------------------------
W = 1_704_067_200  # 2024-01-01 00:00:00 UTC — a Monday, so hour_of_week(W) == 0 (clean baseline bucket).


def _feat(ticker: str, window_start: int, mentions: int, *, velocity=None, sov=0.0) -> EmpiricalFeature:
    """A minimal historical empirical_features row — only (ticker, window_start, mentions, velocity, sov)
    are read back (features_at / sov_ranks_at / feature_history); the rest are filler."""
    return EmpiricalFeature(ticker=ticker, window_start=window_start, mentions=mentions, authors=1,
                            sov=sov, velocity=velocity, accel=None, z=None, net_dir=0.0, dd_count=0,
                            flair_counts="{}", baseline_status="cold", h_e=0.0)


def _m(ticker, thing_id, thing_type, author, flair, dirn, created) -> Mention:
    return Mention(ticker=ticker, thing_id=thing_id, thing_type=thing_type, created_utc=created,
                   author=author, flair=flair, direction=dirn)


def run_scenario(name: str, *, seed_features: list[EmpiricalFeature], mentions: list[Mention],
                 names: dict, cfg: dict, window_start: int = W, weights: dict | None = None) -> None:
    ws = cfg["window_seconds"]
    ww = weights if weights is not None else cfg["weights"]
    gen_at = window_start + 250
    with tempfile.TemporaryDirectory() as td:
        db = DB(Path(td) / "oracle.duckdb")
        db.init_schema()
        db.upsert_empirical_features(seed_features)
        db.upsert_mentions(mentions)

        # Capture the EXACT inputs aggregate_window reads (so the TS port runs DB-free).
        inputs = {
            "window_start": window_start,
            "window_seconds": ws,
            "hour_of_week": hour_of_week(window_start),
            "weights": ww,
            "min_samples_ready": cfg["min_samples_ready"],
            "min_authors_full": cfg["min_authors_full"],
            "mentions_in_window": [list(r) for r in db.mentions_in_window(window_start, window_start + ws)],
            "prior_features": db.features_at(window_start - ws),
            "prior_sov_ranks": db.sov_ranks_at(window_start - ws),
            "feature_history": [list(r) for r in db.feature_history(window_start)],
        }

        rows = aggregate_window(db, window_start, ws, weights=ww,
                                min_samples_ready=cfg["min_samples_ready"],
                                min_authors_full=cfg["min_authors_full"])
        features_out = [r.model_dump() for r in rows]  # in returned (canonical board) order

        snap_path = Path(td) / "leaderboard.json"
        write_snapshot(rows, window_start, ws, snap_path, gen_at, names=names,
                       min_window_mentions=cfg["min_window_mentions"], capped=False)
        snapshot_out = json.loads(snap_path.read_text())
        db.close()

    write_fixture(f"aggregate/{name}.json", {
        "name": name,
        "names": names,
        "generated_at": gen_at,
        "inputs": inputs,
        "features": features_out,  # B4 — ORDER IS PART OF THE CONTRACT
        "snapshot": snapshot_out,  # B5
    })


def dump_aggregate(cfg: dict) -> None:
    print("aggregate H_e + snapshot (B4/B5):")
    ws = cfg["window_seconds"]
    names = {"NVDA": "NVIDIA CORPORATION COMMON STOCK", "AMD": "ADVANCED MICRO DEVICES INC COMMON STOCK"}
    c = W + 100  # all in-window mentions share a timestamp inside [W, W+ws)

    # 1) basic_with_prior — momentum (velocity/accel), rank_delta sign/None, net_dir signs, DD conviction,
    #    support-shrink (NVDA full / TSLA·AMD·PLTR 2-of-3 / GME 1-of-3), and a sov TIE (AMD==PLTR) whose
    #    pre-shrink H_e is also equal, forcing the full deterministic tie-break cascade down to `ticker`.
    run_scenario(
        "basic_with_prior",
        seed_features=[
            _feat("NVDA", W - ws, 2, velocity=1.0, sov=0.4),  # has prior velocity → NVDA accel defined
            _feat("TSLA", W - ws, 3, velocity=None, sov=0.6),  # no prior velocity → TSLA accel None
        ],
        mentions=[
            _m("NVDA", "p1", "post", "alice", "DD", "bull", c),
            _m("NVDA", "c1", "comment", "bob", None, "bull", c),
            _m("NVDA", "c2", "comment", "carol", None, "bull", c),
            _m("NVDA", "c3", "comment", "dave", None, "bear", c),
            _m("TSLA", "p2", "post", "alice", None, "bull", c),
            _m("TSLA", "c4", "comment", "bob", None, "bear", c),
            _m("TSLA", "c5", "comment", "bob", None, "bear", c),  # dup author → authors=2
            _m("AMD", "p3", "post", "erin", None, "neutral", c),
            _m("AMD", "c6", "comment", "frank", None, "bull", c),
            _m("PLTR", "p4", "post", "grace", None, "bear", c),
            _m("PLTR", "c7", "comment", "heidi", None, "bear", c),
            _m("GME", "c8", "comment", "ivan", None, "bull", c),
        ],
        names=names, cfg=cfg,
    )

    # 2) cold_start — NO prior window at all → velocity/accel null for every ticker, rank_delta 0,
    #    z cold/None. Guards the "don't emit 0-based deltas on cold start" invariant.
    run_scenario(
        "cold_start",
        seed_features=[],
        mentions=[
            _m("NVDA", "x1", "post", "alice", None, "bull", c),
            _m("NVDA", "x2", "comment", "bob", None, "bull", c),
            _m("AMD", "x3", "comment", "carol", None, "bear", c),
        ],
        names=names, cfg=cfg,
    )

    # 3) baseline_ready — 8 same-hour-of-week history windows (168h apart → bucket 0) push NVDA's z to
    #    `ready`; exercises the two-pass sample variance (÷ n−1). weights.z==0 so H_e is unchanged, but
    #    the z VALUE and baseline_status are parity targets (a flagged cross-language landmine).
    baseline = [_feat("NVDA", W - 168 * 3600 * k, m, sov=0.3)
                for k, m in enumerate([3, 5, 2, 4, 6, 3, 5, 4], start=1)]
    run_scenario(
        "baseline_ready",
        seed_features=[*baseline, _feat("NVDA", W - ws, 4, velocity=1.0, sov=0.5)],
        mentions=[
            _m("NVDA", "b1", "post", "alice", "DD", "bull", c),
            _m("NVDA", "b2", "comment", "bob", None, "bull", c),
            _m("NVDA", "b3", "comment", "carol", None, "bull", c),
            _m("AMD", "b4", "comment", "dave", None, "bear", c),
        ],
        names=names, cfg=cfg,
    )


def dump_random_scenarios(cfg: dict, *, seed: int = 1729, count: int = 30) -> None:
    """Seeded RANDOM aggregate scenarios — the adversarial property-parity the 3 hand fixtures miss
    (porting-spec §9). Deterministic (fixed seed, run once, committed). Spans varied weekdays/hours
    (hour_of_week off Monday), tie-dense boards (integer counts → SoV ties + near-tie H_e for the
    quantized sort), cold/warming/ready baselines, and HALF use a non-zero `z` weight to exercise the
    z-blend path (config has z=0). The oracle computes the truth; the TS port must match value AND order.
    """
    rng = random.Random(seed)
    print(f"randomized aggregate scenarios (seed={seed}, count={count}):")
    ws = cfg["window_seconds"]
    tickers_pool = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH",
                    "NVDA", "TSLA", "AMD", "GME", "PLTR", "SPY", "QQQ"]
    authors_pool = [f"u{i}" for i in range(8)]
    flairs = [None, None, None, "DD", "Discussion", "YOLO", "Gain"]
    dirs = ["bull", "bear", "neutral"]
    z_weights = {**cfg["weights"], "z": 0.15}  # exercise the z contribution to H_e

    for i in range(count):
        window_start = W + rng.randint(0, 600) * 3600  # varied weekday + hour-of-week
        chosen = rng.sample(tickers_pool, rng.randint(2, 10))
        mentions: list[Mention] = []
        seed_features: list[EmpiricalFeature] = []
        tid = 0
        for tk in chosen:
            for _ in range(rng.randint(1, 7)):
                tid += 1
                mentions.append(_m(tk, f"t{tid}", rng.choice(["post", "comment"]),
                                   rng.choice(authors_pool), rng.choice(flairs), rng.choice(dirs),
                                   window_start + rng.randint(0, ws - 1)))
            if rng.random() < 0.6:  # a prior window (velocity/accel/rank_delta), sometimes null velocity
                pv = rng.choice([None, float(rng.randint(-2, 4))])
                seed_features.append(_feat(tk, window_start - ws, rng.randint(0, 8), velocity=pv, sov=rng.random()))
            for k in range(1, rng.randint(0, 10) + 1):  # same-bucket history → cold/warming/ready
                seed_features.append(_feat(tk, window_start - 168 * 3600 * k, rng.randint(1, 9), sov=0.3))
        run_scenario(f"random/{i:03d}", seed_features=seed_features, mentions=mentions, names={},
                     cfg=cfg, window_start=window_start, weights=(z_weights if i % 2 == 0 else cfg["weights"]))


def check_oracle_frozen() -> None:
    """Warn LOUDLY if wsb_signals/ has drifted from tag v0.0.1 — fixtures regenerated from drifted code
    would silently redefine the oracle (the parity target). Soft check: warn, don't abort."""
    try:
        r = subprocess.run(["git", "-C", str(REPO), "diff", "--quiet", "v0.0.1", "--", "wsb_signals"],
                           capture_output=True)
        if r.returncode == 1:
            print("  ⚠ WARNING: wsb_signals/ DIFFERS from tag v0.0.1 — fixtures may not reflect the frozen oracle!")
        elif r.returncode != 0:
            print(f"  (could not verify v0.0.1 freeze: {r.stderr.decode().strip()[:80]})")
    except Exception as e:  # noqa: BLE001
        print(f"  (oracle-freeze check skipped: {e})")


def main() -> None:
    cfg = load_config()
    print(f"Dumping golden parity fixtures → {FIXTURES.relative_to(REPO)}/  (config: {cfg['weights']})")
    check_oracle_frozen()
    dump_extract_classify()
    dump_wordset_loader()
    dump_aggregate(cfg)
    dump_random_scenarios(cfg)
    print("done.")


if __name__ == "__main__":
    main()
