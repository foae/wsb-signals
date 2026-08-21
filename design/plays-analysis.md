# WSB Plays — agent analysis guide

This is the discovery entry point for agents analyzing captured plays, heat tickers, or their
relationship. The toolkit is read-only: it exposes stored facts, evidence, and quality flags; the
analyzing agent supplies the question and interpretation.

## 1. Start here

Choose the narrowest useful surface:

1. **Discover capabilities:** `GET /api/analysis` or
   `pnpm -C packages/worker analyze -- catalog --pretty`.
2. **Explain one ticker:** `GET /api/analysis/tickers/:ticker` or `analyze -- ticker …`.
3. **Audit one play:** `GET /api/analysis/plays/:id` or `analyze -- play …`.
4. **Analyze a cohort/correlation:** export plays with `--range-basis anchor`, use their stored
   evidence anchors, then join the finalized heat history with the canonical SQL in §7. Do not
   re-derive anchors from screenshot fields.
5. **Bulk/offline work:** `plays-export` writes a snapshot-consistent JSON or CSV file under the
   ignored `data/exports/` directory.

The HTTP CLI uses `WSB_ANALYSIS_URL` (default `http://localhost:3000`). Example:

```bash
WSB_ANALYSIS_URL=http://127.0.0.1:3000 \
  pnpm -C packages/worker analyze -- ticker NVDA \
  --from 2026-08-01 --to 2026-08-21 --pretty
```

Date-only CLI values mean UTC midnight. Numeric timestamps and API epochs must fall between
2010-01-01 and 2100-01-01; extraction/interpretation `runAt` remains millisecond epoch data.

## 2. Mandatory interpretation rules

Every aggregate or correlation output MUST state all of the following:

- **Selection bias:** WSB screenshot posts are self-selected and gains are overrepresented. The
  captured corpus is not representative of traders or trades.
- **Extraction uncertainty:** positions, dates, labels, and P&L are model-extracted from screenshots.
  Use `confidence`, current-run provenance, and the stored evidence rather than treating fields as
  ground truth.
- **Posted P&L is not outcome P&L:** `pnlAbs`/`pnlPct` are what the screenshot showed at post time.
  P5 outcome marks are not implemented yet.
- **No per-ticker win rates:** outcomes stay per post. Never produce a ticker win rate; selection and
  survivorship bias make it misleading (product invariant P5).
- **No causal/trading claim:** proximity between a play and heat is observational context. It does
  not establish that attention caused an outcome and is not a trading recommendation.
- **Radar quality:** identify capped windows as undercounted/low-trust. `quiet`, source freshness,
  and `baselineStatus` also qualify what a heat row can support.

API responses carry stable caveat codes; `GET /api/analysis` maps each code to its full text.

## 3. Time, snapshot, and completeness semantics

- Ranges are **`[from,to)`**.
- Schema timestamps are Unix **seconds**, except extraction/interpretation `runAt`, which is
  milliseconds so fast retries remain distinct.
- A play's correlation anchor comes from the current interpretation's stored
  `evidence.anchor_utc`/`anchor_basis`. `opened_at` anchors were already derived and clamped by the
  worker; `post_time` is the explicitly weaker fallback. Analysis must not derive a different anchor.
- A radar window is **finalized only when a later `cycle_runs` window exists**. The worker republishes
  the current bucket every five minutes and re-aggregates W−1 before W. Ticker analysis therefore
  excludes the newest cycle and reports the latest included window as `meta.asOfWindowStart`.
- A later cycle is an honest but imperfect finalization marker: after a short outage, a boundary
  window can remain short by one final poll slice. Responses carry `finalization-approximation`.
- Each HTTP analysis is one PostgreSQL `REPEATABLE READ, READ ONLY` snapshot. Each web process
  executes at most two analysis reads concurrently so the board retains database capacity; the
  shipped deployment has one web process. Excess requests return 429 with `Retry-After: 15`. The
  direct exporter holds the same snapshot while paging and writing its file.
- A heat row with null ticker fields means the cycle existed but the ticker was not on that window's
  board. A missing cycle is not silently synthesized.

## 4. JSON API

### Catalog

`GET /api/analysis`

Returns schema version, endpoint templates, hard limits, outcome capability, CLI examples, and the
full caveat dictionary. It is intentionally small; this document owns semantics.

### Ticker dossier

`GET /api/analysis/tickers/NVDA?from=<epoch>&to=<epoch>`

Returns:

- the ticker/name plus `known`, which explicitly distinguishes a symbol observed by the asset
  registry, heat rows, or plays from an unknown symbol;
- every finalized cycle in the bounded range (including null/no-heat rows), with empirical heat,
  market overlay, rank/quadrant, `capped`, `quiet`, freshness, and baseline status;
- all published plays whose **stored anchor** falls in the range, including low-confidence and
  `unclassifiable` rows (the web board's display filters never apply here);
- `corpus.basis = "createdUtc"` plus status counts across all tickers in the requested range and
  `corpus.excludedGlobal.unknownCreatedUtc`, so timestamp-less rows are not silently lost;
- explicit truncation when more than 200 relevant plays exist.

Default range: seven days. Hard range: 180 days. Use `plays-export` for broader/cohort work.

### Play audit

`GET /api/analysis/plays/:id?beforeHours=72&afterHours=24`

Returns the play and the exact child rows selected by `currentExtractionAt` and
`currentInterpretationAt`, including their `runAt`, model, prompt version, parsed extraction,
interpretation, and stored evidence. It requests finalized heat in whole radar-window buckets
around the stored anchor. `beforeHours=0&afterHours=0` requests the anchor's bucket; that bucket is
absent when it is the newest, still-provisional window. Both bounds accept 0–720 hours.

`outcomes.status = "tracking_not_implemented"` and `outcomes.marks = null` mean P5 is unavailable;
this is intentionally distinct from a future tracked play with an empty marks array.

## 5. CLI

### HTTP reads

```bash
pnpm -C packages/worker analyze -- catalog --pretty
pnpm -C packages/worker analyze -- ticker NVDA --from 2026-08-01 --to 2026-08-21 --pretty
pnpm -C packages/worker analyze -- play 1vtkzf3 --before-hours 72 --after-hours 24 --pretty
```

JSON is written to stdout; diagnostics and non-zero failures go to stderr.

### Snapshot export

The exporter intentionally refuses the worker writer `DATABASE_URL`. Supply the provisioned
read-only DSN through `ANALYSIS_DATABASE_URL` or `NUXT_DATABASE_URL`:

```bash
ANALYSIS_DATABASE_URL='postgres://wsb_web:…@localhost:5432/wsb_signals' \
  pnpm -C packages/worker plays-export -- \
  --from 2026-08-01 --to 2026-08-21 --range-basis anchor --format json
```

`--range-basis post` (the default) selects by Reddit `createdUtc`; `anchor` selects by the stored
interpretation anchor with the same post-time fallback as the dossier and is the required basis for
correlation work. JSON records expose `anchorUtc`/`anchorBasis`; the header's
`excludedGlobal.unknownBasisTime` and the CLI result's `excludedUnknownBasisTimeGlobal` report the
global number of published rows excluded because the selected basis has no timestamp.

The default path is `data/exports/plays-<basis>-<from>-<to>.json|csv`, resolved from the repository
root; relative `--out` paths are also repo-root-relative. Existing files are never overwritten and
failed exports leave no partial file. One export is capped at 366 days; split longer histories into
explicit files.

JSON is the full-fidelity format. CSV carries the analysis-relevant scalar play fields plus stored
anchors; nested `tags`, media, extraction, interpretation/evidence, marks, and links are JSON
strings in `*Json` columns. Queue-internal scalars remain JSON-only or intentionally omitted. Text
cells are guarded against spreadsheet formula execution. While P5 is unavailable, the JSON header
uses `outcomeCapability` and every record has `outcome.marks = null`.

## 6. Schema map

| Table | Grain | Analysis use |
|---|---|---|
| `plays` | Reddit post | Queue state, posted facts, board denormalization, current-run pointers |
| `play_extractions` | `(play_id, run_at-ms)` | Every extraction run; serve the pointer-selected run |
| `play_interpretations` | `(play_id, run_at-ms)` | Interpretation plus verbatim deterministic evidence |
| `play_marks` | `(play_id, position_id, ts)` | P5 daily outcomes; table exists, producer not implemented |
| `play_links` | play→resolution play | P5 author-followup resolutions; producer not implemented |
| `cycle_runs` | radar window | Atomic publish marker and quality/freshness flags |
| `empirical_features` | `(ticker, window)` | Mentions, authors, SoV, momentum, direction, WSB Heat `h_e` |
| `analytical_features` | `(ticker, window)` | Day-to-date return/rvol metadata |
| `signals` | `(ticker, window)` | Effective Market Heat, divergence, quadrant, rank |
| `mentions` | `(ticker, Reddit thing)` | Raw ticker mentions; use only for a specifically bounded question |

Current-run pointers are mandatory. `max(run_at)` can mix a failed reprocess attempt with the served
version and is never canonical.

## 7. Canonical SQL

Use bound parameters; examples use `:name` placeholders for readability.

### Served play with current child runs

```sql
select p.*, pe.run_at as extraction_run_at, pe.model as extraction_model,
       pe.prompt_version as extraction_prompt_version, pe.output as extraction_output,
       pi.run_at as interpretation_run_at, pi.model as interpretation_model,
       pi.prompt_version as interpretation_prompt_version,
       pi.evidence, pi.output as interpretation_output
from plays p
left join play_extractions pe
  on pe.play_id = p.id and pe.run_at = p.current_extraction_at
left join play_interpretations pi
  on pi.play_id = p.id and pi.run_at = p.current_interpretation_at
where p.id = :play_id;
```

### Finalized ticker trajectory

```sql
with newest as (
  select max(window_start) as window_start
  from cycle_runs where status = 'complete'
)
select c.window_start, c.generated_at, c.quiet, c.capped, c.newest_utc,
       e.mentions, e.authors, e.sov, e.velocity, e.accel, e.z,
       e.net_dir, e.dd_count, e.baseline_status, e.h_e,
       s.h_m, s.divergence, s.quadrant, s.rank, s.rank_delta,
       a.ret, a.rvol, a.rvol_conf
from cycle_runs c
cross join newest n
left join empirical_features e
  on e.window_start = c.window_start and e.ticker = :ticker
left join signals s
  on s.window_start = c.window_start and s.ticker = :ticker
left join analytical_features a
  on a.window_start = c.window_start and a.ticker = :ticker
where c.status = 'complete'
  and c.window_start >= :from and c.window_start < :to
  and c.window_start < n.window_start
order by c.window_start;
```

### Correlation/cohort primitive

This query reads the stored anchor, then aligns bounded offsets to finalized windows. It returns raw
observations, not an aggregate claim. `:window_seconds` is currently 3600; `:offset_hours` is a bound
integer array such as `{-24,0,24,72}`. Missing or malformed stored anchors fall back to post time and
are labeled `post_time`; a target at or after the newest cycle is `provisional`, not a missing cycle.

```sql
with newest as (
  select max(window_start) as window_start
  from cycle_runs where status = 'complete'
), anchor_source as (
  select p.id, p.primary_ticker, p.category, p.confidence,
         p.pnl_abs as posted_pnl_abs, p.pnl_pct as posted_pnl_pct, p.created_utc,
         pi.run_at as interpretation_run_at,
         case when pi.evidence->>'anchor_utc' ~ '^[0-9]{10}$'
           and (pi.evidence->>'anchor_utc')::bigint between 1262304000 and 4102444800
           then (pi.evidence->>'anchor_utc')::bigint end as evidence_anchor_utc,
         pi.evidence->>'anchor_basis' as evidence_anchor_basis
  from plays p
  left join play_interpretations pi
    on pi.play_id = p.id and pi.run_at = p.current_interpretation_at
  where p.status = 'published'
), anchored as (
  select *,
         coalesce(evidence_anchor_utc, created_utc) as anchor_utc,
         case when evidence_anchor_utc is not null
              then coalesce(evidence_anchor_basis, 'post_time')
              when created_utc is not null then 'post_time'
              else null end as anchor_basis
  from anchor_source
), targets as (
  select a.*, off as offset_hours,
         floor((a.anchor_utc + off * 3600)::numeric / :window_seconds)::bigint
           * :window_seconds as window_start
  from anchored a cross join unnest(:offset_hours::int[]) off
  where a.anchor_utc >= :from and a.anchor_utc < :to
)
select t.*, c.capped, c.quiet, e.mentions, e.authors, e.sov, e.h_e,
       s.h_m, s.divergence, s.quadrant, s.rank,
       case when t.window_start >= n.window_start then 'provisional'
            when c.window_start is null then 'missing_cycle'
            when e.ticker is null then 'not_on_board'
            else 'present' end as data_state
from targets t
cross join newest n
left join cycle_runs c
  on c.window_start = t.window_start and c.status = 'complete'
  and c.window_start < n.window_start
left join empirical_features e
  on e.ticker = t.primary_ticker and e.window_start = c.window_start
left join signals s
  on s.ticker = t.primary_ticker and s.window_start = c.window_start
order by t.anchor_utc, t.id, t.offset_hours;
```

Do not use the board UI's confidence/category filters in a cohort unless the question explicitly asks
for that display subset. Always report how many published/failed/discarded rows were considered.

### Category counts (descriptive only)

```sql
select category, count(*) as plays
from plays
where status = 'published' and created_utc >= :from and created_utc < :to
group by category order by plays desc, category;
```

This can describe the captured corpus; it cannot estimate population prevalence or strategy quality.

### Outcome trajectories (P5-ready, currently empty)

```sql
select pm.play_id, pm.position_id, pm.ts, pm.mark_value,
       pm.pnl_abs, pm.pnl_pct, pm.source, pm.feed_conf, pm.note
from play_marks pm
join plays p on p.id = pm.play_id
where p.created_utc >= :from and p.created_utc < :to
order by pm.play_id, pm.position_id, pm.ts;
```

Until the catalog reports `outcomeMarks: true`, zero rows means the producer is unavailable, not
"tracked with no movement."

## 8. Analysis recipes

- **Why is ticker X hot?** Read its dossier; inspect finalized `hE`, SoV/authors, velocity, rank,
  capped state, then nearby stored play anchors. Market `ret`/`rvol` are day-to-date, not
  hour-aligned.
- **Was this play crowd-following?** Audit the play. Use stored `evidence.herd`, its distinct-author
  count and threshold; never reconstruct a different gate from current chatter.
- **Are categories associated with different heat paths?** Export the full published corpus with
  `--range-basis anchor`, align stored anchors with the cohort SQL, retain
  confidence/anchor-basis/capped flags, and report descriptive differences with the §2 caveats. Do
  not call the relationship causal.
- **Longitudinal offline analysis:** prefer JSON export. Preserve `(play id, interpretation.runAt)` in
  intermediate data so a later reprocess cannot silently change cohort membership.

The separate P6 reprocess path and P5 outcome producer remain planned work; this read-only toolkit
can diagnose stale versions but does not mutate or requeue them.
