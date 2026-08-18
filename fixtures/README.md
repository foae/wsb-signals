# Golden parity fixtures

These files are the **v0.0.1 → v2 parity contract**. They were emitted from the **frozen** Python
radar (the oracle, `git tag v0.0.1`) by its `oracle/dump_fixtures.py`, and the TS worker's parity
tests assert against them (`design/v2-porting-spec.md` §1). They are the regression net pinning the
scoring math now that the Python tree is pruned from `main`.

**They are committed on purpose** — the TS test suite reads them directly, so parity tests run with no
Python and no DuckDB at test time.

## Regenerating (only if the scoring contract ever changes intentionally)

The oracle no longer lives on `main`. Use tag **`oracle-final`** — the last pre-prune commit, which
carries both the frozen `wsb_signals/` tree AND the `oracle/dump_fixtures.py` harness. (Tag `v0.0.1`
predates `oracle/`; the harness was built during the v2 port.) Regenerate from a worktree of the tag
and copy the output back:

```bash
git worktree add /tmp/wsb-oracle oracle-final
cd /tmp/wsb-oracle
uv sync                                   # build the frozen Python env (uv reads pyproject + uv.lock)
uv run python oracle/dump_fixtures.py     # → /tmp/wsb-oracle/fixtures/*.json
cp -r fixtures/* <repo>/fixtures/         # copy into the live tree, review the diff, commit
cd - && git worktree remove /tmp/wsb-oracle
```

The dump script warns loudly if the worktree's `wsb_signals/` has drifted from tag `v0.0.1` — drifted
code would silently redefine the oracle. If the intentional change means the oracle can no longer
express the new behavior, update the fixtures by hand and record the divergence in
`design/v2-porting-spec.md` instead.

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
