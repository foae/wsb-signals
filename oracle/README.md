# `oracle/` — the v0.0.1 parity oracle harnesses

The frozen v0.0.1 Python radar (`git tag v0.0.1`, the `wsb_signals/` tree) is the **parity oracle** for the
v2 TypeScript port. Two harnesses here drive it (see `design/v2-porting-spec.md`):

| Script | Boundary | Purpose |
|---|---|---|
| `dump_fixtures.py` | B2–B5, hand-built + 30 seeded-random scenarios | Emit the **committed golden fixtures** (`fixtures/`) the TS unit tests gate on (§1–§5, §9). |
| `replay.py` | B3+B4, **live-captured** | The **live-shadow** gate: replay the worker's real captured inputs through the frozen oracle and diff (§12). |

Both import `wsb_signals` in-place — run them in the v0.0.1 env (`uv run`), from the repo root.

## Golden fixtures (`dump_fixtures.py`)

```bash
uv run python oracle/dump_fixtures.py        # → fixtures/*.json (the COMMITTED parity contract)
```

Regenerate only when the frozen oracle is re-pinned; the emitted `fixtures/` are committed. The script
warns loudly if `wsb_signals/` has drifted from tag `v0.0.1` (drifted code would silently redefine the
oracle). The TS suite asserts deep equality against these — values **and** order (`design/v2-porting-spec.md`
§2.6).

## Live shadow — replay-vs-oracle (the cutover gate)

Deterministic value+order parity on **real live data**: the live TS worker captures the *exact inputs* its
scorer consumed; the frozen oracle replays them; we diff. Same input → any divergence is a real port bug,
not the input noise two independent live polls would produce (`design/v2-porting-spec.md` §12).

```bash
# 1. Run the TS worker in shadow mode against the live APIs. Each cycle writes data/shadow/cycle-<ws>.json.
#    Needs DATABASE_URL (+ ALPACA_* for the H_m overlay). Let it run a sustained window of cycles;
#    --once does a single cycle (handy for a smoke check). SHADOW_DIR overrides the output dir.
pnpm -C packages/worker start --shadow              # or: SHADOW=1 pnpm -C packages/worker start

# 2. Replay those captured inputs through the FROZEN oracle → data/shadow-oracle/cycle-<ws>.json.
uv run python oracle/replay.py data/shadow data/shadow-oracle

# 3. Diff / gate. Exit 0 = parity holds; 1 = DRIFT (a real port bug); 2 = SETUP error (gate couldn't certify).
pnpm -C packages/worker shadow-diff data/shadow data/shadow-oracle        # add --json report.json to save
```

**Verdicts:** `MATCH` (bit-identical) · `NEAR` (within the sub-ε tie tolerance — tolerable) · `DRIFT` (a real
divergence — gate fails). **Exit codes:** `0` parity holds · `1` DRIFT · `2` SETUP error (0 paired cycles, or
undiffed cycles from a stale/partial replay — `--allow-unpaired` to override — or a wordset mismatch).

Each cycle the worker also runs a **post-publish read-back** (`verifyPublished`): it re-reads what landed in
Postgres and diffs it against the board the gate approved, so a write-path bug (a wrong `ON CONFLICT`, a
JSONB/BIGINT coercion, an `h_e` written NULL, a missing `cycle_runs` marker) shows up as a `DRIFT` read-back —
the seam replay-vs-oracle structurally can't see.

**Cutover criterion (the shadow alone is necessary but not sufficient):** cut over only when, over a sustained
window, **(1) no DRIFT**, **(2) every cycle's read-back is OK**, **and (3) the testcontainers ITs are green**
(`pnpm -C packages/worker test:it`). See `design/v2-porting-spec.md` §12 for exactly what each layer covers.

**Notes**
- **Paths resolve against the repo root.** All three commands take `data/shadow` / `data/shadow-oracle`:
  the worker writes them via `findRoot()` and `replay.py` runs from root, and `shadow-diff` (invoked with
  `pnpm -C packages/worker …`, so cwd = `packages/worker`) likewise resolves relative dir args against the
  project root. So the relative paths above work from any cwd; absolute paths pass through unchanged.
- **B4 (scoring) parity is wordset-independent** — it replays the captured mention rows directly, so it
  holds regardless of the whitelist.
- **B3 (mention) parity needs the SAME wordsets** the worker used: run `replay.py` against the **same repo
  state**, especially the derived (gitignored) `whitelist/symbols.txt` (`uv run wsb build-whitelist`). A
  mismatch is now *detected* (each dump carries a wordset fingerprint) and reported as a SETUP error rather
  than a confusing B3 DRIFT. If `symbols.txt` is absent, both worker and replay **fail-closed identically**
  to cashtag-only — still parity, reduced coverage.
- A few cycles legitimately land **NEAR**, not a bug: the oracle's `z` uses Python `var ** 0.5` (libm `pow`,
  occasionally 1 ULP off correctly-rounded) while the TS port uses `Math.sqrt` — a ≤1-ULP `z` difference on
  ~0.08% of baseline-ready tickers (`design/v2-porting-spec.md` §2.4, §12).
