# WSB Signals — JSON Schema Contract

These JSON Schema files are the **machine-readable canonical contract** for the WSB Signals data model.
They are kept in sync with:

- [`../data-dictionary.md`](../data-dictionary.md) — the human-readable per-field reference (definitions, formulas, null semantics, lifecycle, source)
- [`../data-model.md`](../data-model.md) — entity grain, keys, relationships, and the logical type vocabulary

**Logical types only.** No physical storage types are expressed here. Every field references a logical type from [`_common.json`](./_common.json) via `$ref`. The binding of logical → physical (e.g. `Instant` → `timestamptz` vs epoch-`bigint`, `Money` → `numeric`) is a single implementation-time decision, not part of this contract.

---

## `x-` annotation vocabulary

| Annotation | Where | Meaning |
|---|---|---|
| `x-grain` | entity top-level | What one row/document represents. |
| `x-natural-key` | entity top-level | Array of field names forming the natural key. |
| `x-key` | property | `true` on each field that is part of the natural key. |
| `x-lifecycle` | entity or property | Publication/implementation status token (see below). |
| `x-src` | property | Originating source: `reddit`, `discord`, `reddit\|discord`, `stock`, `options`, `calc`, `ref`, `meta`. |
| `x-time` | Instant properties | `event` (when the thing happened) or `observation` (when we saw/derived it). |
| `x-null` | nullable properties | What `null` means for this field. null ≠ zero — see below. |
| `x-derived-from` | entity top-level | Source entity/entities this rollup is derived from. |
| `x-constraint` | entity top-level | Hard modeling constraint (e.g. survivorship firewall on `post_classification`). |
| `x-mode` | derived/signal properties | Degradation mode: `core` (works on minimal data), `enriched` (quality rises with more sources), `gated` (impossible without a specific source). See [`../signals-catalog.md`](../signals-catalog.md). |
| `x-sources` | derived/signal properties | Array of source types required by this field. |
| `x-requires` | derived/signal properties | Array of field names this field depends on **within the same entity**. **Documentation, not a full graph** — see the scoping note below. |
| `x-degrades-when` | derived/signal properties | Condition under which the field's quality degrades (but it remains computable). |
| `x-unit` | Duration properties | Logical unit of the duration (e.g. `hours`, `seconds`). |

> **`x-requires` scope.** These annotations are **inline, same-entity hints** — they are *not* a
> transitive, cross-entity dependency graph (e.g. `sov` ← `mention` ← `content_item` ingest; `z` ←
> `baseline`). The **authoritative** computability/degradation graph is
> [`../signals-catalog.md` §4](../signals-catalog.md) (the degradation matrix); a runtime
> "compute-what-you-can" engine should drive off that, using these annotations only as readability hints.
>
> **Composite null-handling** (`H_e`/`H_m`) is class-specific: an *undefined-momentum* null
> (`velocity`/`accel`, no prior) coalesces to **0** (neutral); a *source-absent* null (`dd_count`/`z`
> unavailable) is **excluded and the remaining weights renormalize** — never zero-substituted
> ([`../data-dictionary.md` §10.1](../data-dictionary.md)).

### `x-lifecycle` tokens

| Token | Meaning |
|---|---|
| `live` | Computed, stored, and surfaced in the dashboard / JSON snapshot today. |
| `live-internal` | Computed and stored today; not surfaced externally. |
| `txn` | Computed transiently during aggregation today; not persisted (canonical model persists it). |
| `def` | Column exists today but is not populated (defined-unwritten). |
| `new` | Recently added to the explicit schema; previously implicit. |
| `P2` / `P3` / `P4` | Planned: Phase-2 options increment / Phase-3 signals / Phase-4 enrichment. |

---

## Files

| File | Entity | Grain | Status |
|---|---|---|---|
| `_common.json` | shared types & enums | — | live |
| `instrument.json` | `instrument` | one tradable symbol | partial |
| `author.json` | `author` | one community account | P4 |
| `content_item.json` | `content_item` | one post/comment/message | partial |
| `mention.json` | `mention` | one ticker × content_item | live |
| `empirical_feature.json` | `empirical_feature` | ticker × window × resolution | live |
| `analytical_feature.json` | `analytical_feature` | ticker × window × resolution (WSB-hot ∪ screener) | live |
| `signal.json` | `signal` | ticker × window × resolution (full outer join) | def |
| `baseline.json` | `baseline` | ticker × resolution × bucket × slot | def |
| `market_bar.json` | `market_bar` | ticker × bar_ts | def |
| `options_contract.json` | `options_contract` | ticker × snap_ts × expiry × strike × right (raw) | P2 |
| `options_snapshot.json` | `options_snapshot` | ticker × snap_ts (derived from options_contract) | def |
| `market_mover.json` | `market_mover` | ts × kind × rank | live |
| `ingestion_run.json` | `ingestion_run` | source × kind × poll_ts (coverage/provenance) | new |
| `engagement_settled.json` | `engagement_settled` | platform × thing_id | P4 |
| `post_classification.json` | `post_classification` | platform × thing_id | P4 |

Enums in `_common.json`: `Platform ContentKind Direction BaselineStatus Resolution Quadrant MoverKind Confidence Feed Source WinLoss AssetClass ListingStatus SignalMode CoverageScope BucketScheme OptionRight`.

---

## null means undefined, never zero

A measured zero (0 mentions, 0% return) is a value. `null` means the quantity **could not be computed
this cell** — no prior window (`velocity`/`accel`), baseline not ready (`z`), ticker outside the market
top-N (`ret`/`rvol`/`h_m`), source unavailable (`pcr`/`iv_rank`). Every nullable field carries an
`x-null` annotation stating its trigger. Aggregations must use null-aware reducers; never substitute 0.
