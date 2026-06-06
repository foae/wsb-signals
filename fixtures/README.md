# Golden parity fixtures

These files are the **v0.0.1 → v2 parity contract**. They are emitted from the **frozen** Python radar
(the oracle, `git tag v0.0.1`) by [`oracle/dump_fixtures.py`](../oracle/dump_fixtures.py), and the TS
port asserts against them slice-by-slice (`design/v2-porting-spec.md` §1, build order in
`design/v2-plan.md` §4).

**They are committed on purpose** — the TS test suite reads them directly, so parity tests run with no
Python and no DuckDB at test time. Regenerate only when the oracle is re-pinned:

```bash
uv run python oracle/dump_fixtures.py     # from repo root, in the v0.0.1 env
```

## What's here

| File | Boundary | Slice | Contents |
|---|---|---|---|
| `extract_classify.json` | B3 | 1 | `regex` + `wordsets` (stop/whitelist/ambiguous) + cases: each text → `classify()` `[symbol, decision]`, `extract()`, `direction()`. Covers cashtag-override, `too_short`, `stop`, `not_listed`, the ambiguous-context gate, `open` vs `whitelist` mode, the 6-letter no-match boundary, and extract≠direction. |
| `aggregate/basic_with_prior.json` | B4 + B5 | 2 | Velocity/accel (with/without a prior velocity), `rank_delta` sign/None, `net_dir` signs, DD conviction, support-shrink (full / 2-of-3 / 1-of-3), and a **sov tie** (AMD≡PLTR, equal H_e) that forces the deterministic tie-break cascade down to `ticker`. |
| `aggregate/cold_start.json` | B4 + B5 | 2 | No prior window → `velocity`/`accel` null, `rank_delta` 0, `z` cold. |
| `aggregate/baseline_ready.json` | B4 + B5 | 2 | 8 same-hour-of-week history windows push `z` to `ready`; pins the two-pass sample variance (÷ n−1) — a flagged cross-language landmine. |

## Aggregate fixture shape (DB-free replay)

Each `aggregate/*.json` carries the **exact inputs** `aggregate_window` consumed — captured by calling
the real `db.mentions_in_window` / `features_at` / `sov_ranks_at` / `feature_history` — plus the config
(`weights`, `min_samples_ready`, `min_authors_full`, `window_*`). The TS port feeds those inputs and
diffs:

- `features` — the `EmpiricalFeature[]` **in returned order** (board order is part of the contract).
- `snapshot` — the `write_snapshot` payload (the `leaderboard.json` shape, with its rounding + `pretty_name`).

Numerics are full-precision; the parity test compares floats within tolerance, but structure, strings,
ints, ordering, and null-vs-value must match exactly.
