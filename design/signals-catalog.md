# Signals Catalog — *what* can be inferred from *where*

> The third pillar. For every signal the radar produces, this catalogue states **what it is**, **which
> source(s) it needs**, **whether it's available today**, and **how its quality degrades** when a source
> is thin or absent. It is the bridge between the [data model](./data-model.md) /
> [dictionary](./data-dictionary.md) (the *fields*) and the product (the *inferences*).
>
> **The governing principle — design for full access, build for graceful degradation.** We design as if
> we already have full Reddit **and** Discord chatter **and** a complete market funnel (real-time
> full-volume prices **and** the options matrix). The system is **source-modular**: a missing/thin
> source never breaks the pipeline — it only makes some signals **impossible** (they return `null`) or
> **lower quality** (flagged via `Confidence`), while everything that doesn't depend on it keeps working.

---

## 1. The modularity contract

Every signal is one of three **modes**:

| Mode | Meaning | If a richer source is missing |
|---|---|---|
| **core** | Computable from the **minimum data we already have** (Reddit chatter + a stock price). | Unaffected (at most narrower scope). |
| **enriched** | Computable now, but **quality rises** with more/better sources. | Still computed; flagged **lower confidence**. |
| **gated** | **Impossible** without a specific source. | Returns `null` + a reason; dependents skip it. |

**Encoding (machine-readable).** Each derived field in [`schema/`](./schema/) carries annotations so the
engine can decide computability at runtime without hardcoding:

```jsonc
"h_e":  { "x-mode": "core",     "x-sources": ["reddit","discord"], "x-requires": ["sov","accel","authors"] },
"rvol": { "x-mode": "enriched", "x-sources": ["stock"],            "x-degrades-when": "feed=iex (thin volume)" },
"pcr":  { "x-mode": "gated",    "x-sources": ["options"],          "x-requires": ["call_vol","put_vol"] }
```

The runtime rule: **compute what the available inputs allow; `null` the rest with a reason; never
substitute zeros or stale values for missing inputs** (that would silently corrupt a downstream blend).
For the *null-handling inside a composite*, the rule is class-specific — undefined-momentum coalesces to
0, a source-absent component is excluded and the weights renormalize ([data-dictionary §10.1](./data-dictionary.md#101-null-handling-in-composites)).

> **Scope of the annotations.** `x-requires`/`x-mode`/`x-sources` are **inline, same-entity hints** — they
> are *not* a transitive, cross-entity dependency graph (`sov` ← `mention` ← `content_item` ingest; `z` ←
> `baseline`). The **authoritative** computability/degradation graph is the [degradation matrix in §4](#4-degradation-matrix-headline-signals--data-tiers);
> a runtime "compute-what-you-can" engine drives off that, using the annotations as readability hints.

---

## 2. Source affordances — what each source *uniquely* provides

The signals follow from what each source can and cannot see. Four sources, two families.

### Community sources

| | **Reddit** (r/wallstreetbets, Arctic-Shift) | **Discord** (wsbverse / unofficial) |
|---|---|---|
| **Volume / cadence** | High; the Daily Discussion Thread is a firehose. ~5-min content latency. | Real-time chat; **faster**, more casual, burstier. |
| **Structured label** | **`flair`** (DD / YOLO / Gain / Loss / News / Discussion) — high-integrity, human-applied. The backbone of conviction + outcome framing. | **No flair.** Analog = **`channel`** (a #ticker or #options room) + **author `roles`**. |
| **Endorsement** | `score`/upvotes — **settles ~36 h** (scrapers wrong before then) ⇒ **not a live signal**. | **`reaction_counts`** (emoji) — **live**, no lag. A real-time endorsement Reddit can't give. |
| **Author trust** | Karma + account age (Arctic-Shift user data) → `author_cred`, `astroturf`. | Server `roles` + join date; karma absent. |
| **Denominator (SoV)** | Clean — whole-sub activity is countable ⇒ honest `sov`. | **Messier** — no global denominator; SoV is per-channel or per-active-users (define carefully). |
| **History / backfill** | **Archived & backfillable** (dumps) ⇒ accelerates `z` baselines + lead-lag. | Poor archival; **ToS/access constraints**; mostly forward-only. |
| **Bias** | Survivorship (winners post), reflexivity. | **Higher manipulation/coordination base rate** (raids are easy); more small-cap/pump-y. |

> **Takeaway:** Reddit is the **structured, archival, denominator-clean** source (conviction, baselines,
> SoV). Discord is the **fast, live-endorsement, early** source (reactions, lead). They are complementary
> — the cross-source signals in [§5](#5-cross-source-signals-community--community) exist *because* of this.

### Market sources

| | **Stock feed** (Alpaca IEX free / SIP / IBKR) | **Options matrix** (Alpaca indicative / paid Greeks) |
|---|---|---|
| **Always-cheap** | **Price** (`ret`, `gap`, `range`) — available even on free IEX. | — |
| **Quality-gated** | **Volume** (`rvol`): IEX ≈ 2.5% of volume ⇒ **low-confidence**; SIP/IBKR ⇒ full, high-confidence. | All options signals require an options feed at all. |
| **Unique** | **Screeners** (most-actives / movers) = a **market-wide read** ⇒ STEALTH. | `pcr`, `iv_rank`, `iv_skew`, `uoa`, `breadth` — the **market's conviction & the WSB "lotto fingerprint"** (low breadth + call-heavy + rising IV). A cross-check on community `net_dir`. |

> **The price/volume split is the canonical degradation example:** identifying a **hot/hyped** ticker
> needs only community chatter + a **price** (both available today). A **thin volume** feed degrades the
> *quality* of the market-confirmation signal (`rvol`, `H_m`) — it does **not** stop us flagging the
> ticker as hot.

---

## 3. The signal catalog

Each signal: definition, required inputs, source(s), mode, available-today, and degradation. Field
definitions are in [`data-dictionary.md`](./data-dictionary.md).

### 3.1 Attention & trending — the "hot" detector *(community-only)*

| Signal | What it tells you | Inputs | Source | Mode | Today? |
|---|---|---|---|---|---|
| **Attention** (`mentions`, `authors`, `sov`) | How much air-time a ticker has *right now*. | mention counts | R / D | **core** | ✅ Reddit |
| **Momentum** (`velocity`, `accel`, `rank_delta`) | Is chatter *building*, and is it *climbing the board*? The trending core. | attention over consecutive windows | R / D | **core** | ✅ Reddit |
| **Anomaly** (`z`) | Is this unusual *for this ticker* vs its own hour-of-week norm? | attention + baseline history | R / D | **enriched** | ◑ warms forward; Reddit backfill ↑ |
| **WSB Heat `H_e`** | **"How hot on WSB right now"** — the headline ranker. | sov+accel+rank_delta+authors+dd+\|net_dir\|+z\* | R / D | **core** | ✅ **Reddit alone** |

> **`H_e` needs no market data.** This is the user's anchor case: *hot* is a pure community inference,
> live today on Reddit. Discord **enriches** it (adds live-reaction endorsement + earlier signal);
> absent Discord, `H_e` is Reddit-only and fully valid.

### 3.2 Direction & conviction

| Signal | What it tells you | Inputs | Source | Mode | Today? |
|---|---|---|---|---|---|
| **Direction** (`net_dir`) | Bull vs bear lean from options/position language (not ironic sentiment). | direction tokens in text | R / D | **core** (crude) | ✅ keyword |
| **LLM stance** (`llm_stance`) | Higher-accuracy stance/option-play classification. | text + LLM | R / D | enriched (P4) | ⛔ later |
| **Reddit conviction** (`dd_count`, flair mix) | Effortful, researched conviction; often *leads* attention. | `flair = DD` | **R only** | **gated on Reddit** | ✅ |
| **Discord conviction** (channel/role mix) | Discord's flair-analog: ticker-channel concentration + trusted-role authors. | `container`, `roles` | **D only** | gated on Discord | ⛔ no Discord yet |
| **Options conviction** (`pcr`, call-heavy, `uoa`, `breadth`) | **The market's** directional conviction + the WSB lotto fingerprint. Cross-checks community `net_dir`. | options chain | **opt only** | **gated on options** | ⛔ options increment |

> **`dd_count` honours the gated-null contract.** Because it is gated on Reddit (flair), it is **`null`,
> not `0`, on a Discord-only cell** — and a `null` conviction term is **excluded from `H_e` and the
> remaining weights renormalize**, never substituted with 0 (which would silently penalize Discord-driven
> tickers). `0` means "Reddit present, no DD posts"; `null` means "no Reddit data here". Same rule for
> every gated component ([data-dictionary §10.1](./data-dictionary.md#101-null-handling-in-composites)).

### 3.3 Endorsement (does the crowd *agree*?)

| Signal | What it tells you | Inputs | Source | Mode | Today? |
|---|---|---|---|---|---|
| **Discord live endorsement** (`reaction_counts`) | Real-time agreement velocity — no lag. | reactions | **D only** | gated on Discord | ⛔ |
| **Reddit settled endorsement** (`eng_per_mention`) | Endorsed chatter vs noise — **>36 h only**. Feeds a *settled* `H_e`, never the live one. | settled `score` | **R only** | enriched (P4), lagged | ◑ post-hoc |

> Endorsement is the clearest Reddit/Discord asymmetry: Reddit's is **lagged** (scrapers), Discord's is
> **live**. With Discord, the radar gains a same-window endorsement signal it structurally cannot get
> from Reddit.

### 3.4 Quality / manipulation flags

| Signal | What it tells you | Inputs | Source | Mode | Today? |
|---|---|---|---|---|---|
| **Astroturf** (`astroturf`) | Share of mentions from new accounts / coordinated bursts. **A warning, not a trade.** | author age / burst shape | R / D | enriched (P4) | ⛔ later |
| **Author credibility** (`author_cred`) | Down-weight brand-new / low-trust accounts. | karma+age (R) / roles+join (D) | R / D | enriched (P4) | ⛔ later |
| **Bot filtering** | Exclude automation from all counts. | bot list | R / D | **core** | ✅ |

> Discord's coordination base rate is higher → `astroturf` matters *more* there, but its inputs (roles,
> join dates) differ from Reddit's (karma, account age). The signal is the same; its evidence is
> source-specific.

### 3.5 Market action *(the analytical overlay)*

| Signal | What it tells you | Inputs | Source | Mode | Today? |
|---|---|---|---|---|---|
| **Return** (`ret`) | Is the price actually moving today? | price | **stk** | **core** | ✅ (price is cheap) |
| **Relative volume** (`rvol`) | Is the *market* reacting (vs the ticker's norm)? The market twin of `sov`/`z`. | volume + baseline | **stk** | **enriched** | ◑ low-conf on IEX |
| **Vol-unit move** (`\|ret\|/realized_vol`) | A move sized against the ticker's own volatility. | price history | **stk** | enriched (P4) | ◑ |
| **Market Heat `H_m`** | "How hard the market is moving it." | \|ret\|+rvol(+options) | **stk** (+opt) | **enriched** | ✅ price-driven; ↑ with SIP/options |

### 3.6 The product — Attention × Action *(Phase 3)*

| Signal | What it tells you | Inputs | Source | Mode | Today? |
|---|---|---|---|---|---|
| **HYPE** (quadrant) | Loud on WSB, market not (yet) confirming — watch for breakout/fade. | `H_e` high + `H_m` low | R/D + **stk** | **core** | ✅ Reddit + price |
| **CONFIRMED** | Chatter *and* action agree — move is real (maybe late). | `H_e` high + `H_m` high | R/D + **stk** | **enriched** | ✅; quality ↑ w/ volume+options |
| **STEALTH / EARLY** | Market moving, WSB hasn't noticed — WSB may pile in next. | screener movers ∖ WSB-hot | **stk screener** + R/D | **enriched** | ◑ bounded to loud movers; paid full-market ↑ |
| **QUIET** | Both low — ignore. | `H_e` low + `H_m` low | R/D + stk | core | ✅ |
| **Divergence** (`H_e − H_m`) | Signed gap: +ve = hype ahead of market; −ve = market ahead of WSB. | both heats | R/D + **stk** | **enriched** | ✅; null when an axis is absent |

> **STEALTH is representable because the `signal` cell is a *full outer join*** of empirical + analytical
> ([data-model §5.3](./data-model.md#53-derived-rollups-regenerable-grain--instrument--window_start--resolution)).
> A screener mover with no WSB chatter has **`coverage_scope = screener_mover`, `H_e = null`** — treated
> as WSB-quiet, so it still earns the `stealth` badge (with `divergence = null`, since you can't subtract
> an unknown). The earlier "analytical ⊆ empirical" model would have **dropped these cells entirely** —
> the review fix that makes STEALTH possible at all.

> **HYPE and CONFIRMED are live today** on Reddit + a stock price — exactly the user's point. Options +
> full volume sharpen *which* quadrant and *how confidently*, but the four-way split itself does not
> require them.

### 3.7 Lead-lag — the defensible insight *(Phase 3)*

| Signal | What it tells you | Inputs | Source | Mode | Today? |
|---|---|---|---|---|---|
| **Community → Market lead-lag** (`lead_lag_hrs`) | "On T, WSB attention has led volume by ~x h." **Association, not prediction** (reflexivity). | `H_e(t)` + `H_m(t)` series | R/D + **stk** | **enriched** | ◑ needs stored series; ↑ w/ volume fidelity + Reddit backfill |

---

## 4. Degradation matrix (headline signals × data tiers)

`✓` full · `◑` computed at reduced quality · `⛔` impossible · `—` n/a. Tiers are **cumulative**
(`T0` = what we have today).

| Signal | **T0**: Reddit + IEX price/thin-vol + screeners | **+ Discord** | **+ Full volume** (SIP/IBKR) | **+ Options matrix** | **+ Reddit backfill** |
|---|:--:|:--:|:--:|:--:|:--:|
| `sov` / attention | ✓ | ✓ (+cross-platform) | — | — | — |
| Momentum (`velocity`/`accel`) | ✓ | ✓ | — | — | — |
| `z` anomaly | ◑ (warming) | ◑ | — | — | **✓** (history) |
| **`H_e` (hot)** | **✓** | ✓ (+live reactions) | — | — | ◑→✓ via z |
| `net_dir` (direction) | ◑ (keyword) | ◑ | — | **✓** (pcr cross-check) | — |
| `dd_count` (conviction) | ✓ (Reddit flair) | ✓ (+channel/role) | — | — | — |
| Live endorsement | ⛔ (Reddit lags 36 h) | **✓** (Discord reactions) | — | — | — |
| `rvol` / market reaction | ◑ (thin IEX) | — | **✓** | — | — |
| **`H_m` (market heat)** | ◑ | — | **✓** (volume) | **✓** (options) | — |
| Options conviction / fingerprint | ⛔ | — | — | **✓** | — |
| **HYPE / CONFIRMED quadrant** | **✓** | ✓ | ✓ (confidence ↑) | ✓ (confidence ↑) | — |
| **STEALTH** | ◑ (loud movers only) | ◑ | ◑ | ◑ | — |
| Divergence (`H_e−H_m`) | ◑ | ◑ | ✓ | ✓ | — |
| Community→Market lead-lag | ◑ | ◑ | ✓ | ✓ | ✓ |
| **Cross-platform lead-lag / confirm** | ⛔ | **✓** | — | — | — |

**Reading it:** the **"hot/hyped" column (T0) is already green** — the product's core works on data we
have. Every other source adds quality or unlocks a *new* signal (live endorsement needs Discord; the
options fingerprint needs options; trustworthy `rvol` needs full volume) — but none is a prerequisite
for the core radar.

---

## 5. Cross-source signals (community × community)

Only possible with **both** Reddit and Discord — and genuinely novel (gated on Discord):

- **Cross-platform confirmation.** A ticker hot on **both** is a stronger community signal than either
  alone (independent crowds agreeing). Encoded as a combined `H_e` plus per-platform `H_e` components.
- **Discord → Reddit lead-lag.** Discord chat (fast, casual) often **precedes** a Reddit DD post. A
  measurable intra-community lead — distinct from the community→market lead-lag, and a leading indicator
  *of WSB itself*.
- **Live-reaction front-running.** Discord `reaction_counts` spike in the same window; Reddit upvotes
  won't confirm for ~36 h. The Discord reaction is the **early** read of crowd agreement.
- **Cross-source astroturf triangulation.** The same new-account/role burst appearing on both platforms
  in lockstep is a stronger manipulation flag than either source alone.

**Combined SoV — defined (don't pool raw counts).** Each platform has its **own denominator**:
`sov_reddit(T) = mentions_reddit(T) / Σ_t mentions_reddit(t)`, likewise `sov_discord`. The combined
community share is a **weighted blend of the per-source SoVs**, not a pooled count:

```
sov_combined(T,W,r) = Σ_p  platform_weight[p] · sov_p(T,W,r)        ( Σ_p platform_weight[p] = 1 )
```

**Why not pool** `mentions_reddit + mentions_discord` over one denominator: Discord's message volume is
far higher and far noisier, so a pooled count lets Discord swamp Reddit, and the two have no common unit
(a Discord one-liner ≠ a Reddit DD post). The blend keeps each platform on its own scale and lets
`platform_weight` express trust. *Within* a platform, per-item `weight` (`1/n` for multi-ticker posts,
DD-boost) refines the count; *across* platforms, `platform_weight` does. If a source is absent its term
drops and the rest renormalize (Reddit-only today ⇒ `platform_weight = {reddit: 1}`). The model
materializes per-platform **and** combined cells (the optional `platform` grain dimension), so this is a
data/config question, not a schema change.

---

## 6. What this means for the build

1. **Ship the core on what we have.** Reddit + stock price ⇒ a working hot/hyped radar **today**. Don't
   block it on Discord, full volume, or options.
2. **Treat every other source as an enrichment plug.** Each one improves quality (`rvol`→SIP, `z`→
   backfill) or unlocks a gated signal (reactions→Discord, fingerprint→options) **without touching the
   core**. The `x-mode`/`x-sources`/`x-requires` annotations let the engine light up signals as sources
   come online.
3. **Always flag degraded quality, never fake it.** Low-confidence `rvol`, cold `z`, keyword-only
   `net_dir` are *surfaced as such*. A missing input ⇒ `null` + reason, never a zero or a stale value.
4. **The Reddit/Discord split is a feature.** Reddit gives structure + history + a clean denominator;
   Discord gives live endorsement + earliness. The cross-source signals (§5) are the payoff for carrying
   both behind one `content_item`.
