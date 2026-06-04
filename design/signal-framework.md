# Signal Framework (v0.0.1)

> The conceptual core of WSB Signals: how raw Reddit chatter and market data become two
> comparable signal families, and how their interaction becomes the radar's output.
> Read [`../sources/wallstreetbets.md`](../sources/wallstreetbets.md) first for the data's
> quirks and biases — they are designed into this framework, not ignored.

## 1. The unit of analysis: the (ticker, window) cell

Everything is computed **per ticker `T`, per time window `W`**. A cell `(T, W)` holds a vector
of features from two families:

- **Family A — Empirical signals** — what the *community* is doing (Reddit now; Discord later).
- **Family B — Analytical signals** — what the *market* is doing (price, volume, options).

The radar's job is to surface cells where Family A is unusually "hot," then show how Family B
is (or isn't) responding. **Attention vs. Action.**

> **Why per-window, not per-post:** a radar measures *rates and changes*, not events. Posts and
> trades are the raw material; the signal lives in how `(T, W)` cells move over time.

---

## 2. Family A — Empirical signals (Reddit)

Per `(T, W)`. Grouped by what they capture.

### 2.1 Attention (how much air-time)
| Feature | Definition | Notes |
|---|---|---|
| `mentions` | # posts + comments referencing `T` in `W` | Comments dominate — most chatter is in the Daily Discussion Thread. |
| `authors` | # **distinct** authors mentioning `T` | Robust to one account spamming. Prefer over raw `mentions` for ranking. |
| `sov` | `mentions(T,W) / Σ_t mentions(t,W)` — **share of voice** | Normalizes for overall sub activity. The core attention metric. |
| `flair_counts` | mentions split by flair: DD / YOLO / Gain / Loss / News / Discussion | Flair is a high-integrity label (§4, wallstreetbets.md). |

### 2.2 Momentum (the "trending" core)
| Feature | Definition | Notes |
|---|---|---|
| `velocity` | `mentions(T,W) − mentions(T,W−1)` | First derivative. |
| `accel` | `velocity(W) − velocity(W−1)` | Second derivative — catches *breakouts* early. |
| `z` | `(mentions(T,W) − μ_base) / σ_base` | Baseline = same hour-of-week, trailing *K* weeks. Answers **"is this unusual for this ticker?"** — the radar's anomaly trigger. |
| `rank`, `rank_delta` | position in the `sov` leaderboard, and its change | A ticker climbing the board fast is the headline event. |

### 2.3 Direction / stance (bullish vs bearish)
| Feature | Definition | Notes |
|---|---|---|
| `net_dir` | `(bull − bear) / (bull + bear)` ∈ [−1, +1] | From directional tokens: **bull** = calls/long/buy/🚀/"loading"; **bear** = puts/short/sell/"drilling". |
| `flair_dir` | flair-implied lean | YOLO/DD skew to conviction; Gain bullish-outcome; Loss ambiguous. Blend with `net_dir`. |

> WSB sentiment words are **inverted and ironic** (§3, wallstreetbets.md). **Direction
> (calls/puts, bought/sold) is far more reliable than generic sentiment polarity.** Treat
> lexical sentiment as a weak feature; treat options-word direction as a strong one.

### 2.4 Conviction (skin in the game)
| Feature | Definition | Notes |
|---|---|---|
| `dd_count` | # of DD (Due Diligence) posts on `T` in `W` | Effortful conviction; often *leads* attention. |
| `yolo_usd` | Σ of disclosed position $ (YOLO/Gain/Loss) | Often only in an **image** → OCR/vision needed. v0.0.1: text-extractable subset only. |

### 2.5 Engagement / endorsement (does the crowd agree?)
| Feature | Definition | Notes |
|---|---|---|
| `upvotes`, `comments`, `awards` | community endorsement of `T`-content | **Post-hoc only** (>36 h). The taps report `score`/`num_comments` wrong for ~36 h and the Reddit API is excluded — so this is **not a live input**. |
| `eng_per_mention` | `upvotes / mentions` | Separates *endorsed* chatter from noise/spam — only on settled (>36 h) data. |

> **Scrapers-only consequence (see [`../sources/reddit-data-access.md`](../sources/reddit-data-access.md) §3):**
> with no Reddit API, live upvote-velocity is unavailable. Engagement is reconciled after ~36 h
> and feeds a separate *settled* score for tuning/backtests — the **live** `H_e` (§5) is built
> from content-derived signals only.

### 2.6 Trust adjustments (de-noising)
| Feature | Definition | Notes |
|---|---|---|
| `bot_filtered` | exclude known bots (`wsbapp`, `AutoModerator`, `VisualMod`, …) | Do this at ingestion. |
| `author_cred` | tenure/karma weighting (Arctic-Shift user data) | Down-weight brand-new accounts. |
| `astroturf` | share of mentions from <X-day-old accounts / sudden bursts | Manipulation flag, not a signal to trade on. |

---

## 3. Family B — Analytical signals (market data, Polygon/Massive)

Per `(T, W)`. The market analog of "is this unusual?" is **relative** (vs the ticker's own
recent norm), not absolute.

### 3.1 Price
| Feature | Definition |
|---|---|
| `ret` | window return (close-to-close or VWAP-to-VWAP) |
| `gap` | overnight gap |
| `range` | intraday high–low range |
| `realized_vol` | stdev of returns over trailing *n* (used to express moves in vol-units) |

### 3.2 Volume
| Feature | Definition | Notes |
|---|---|---|
| `vol` | shares traded in `W` | |
| `rvol` | `vol(T,W) / avg_vol(T, trailing-N same session)` — **Relative Volume** | The market twin of `sov`/`z`. **The key "is the market reacting?" metric** — but only as good as the feed: **low-confidence on free IEX/EOD volume**, reliable on a paid SIP feed ([market-data-access](../sources/market-data-access.md)). |

### 3.3 Options — "matrix breadth"
The **options matrix** is the grid of **(strike × expiry)** contracts for `T`. Per `W`:

| Feature | Definition | Notes |
|---|---|---|
| `call_vol`, `put_vol` | contract volume by type | |
| `pcr` | `put_vol / call_vol` — put/call ratio | <1 = call-heavy (typical WSB bullish lotto). |
| `call_oi`, `put_oi`, `d_oi` | open interest & its change | OI change = real positioning, not just churn. |
| `atm_iv` | at-the-money implied vol | |
| `iv_rank` | percentile of `atm_iv` vs trailing ~1y | Level-independent "is IV high?". |
| `iv_skew` | `IV(OTM puts) − IV(OTM calls)` (e.g. 25-delta) | Crash-fear vs call-chase. |
| `uoa` | unusual options activity: `vol/OI ≫ 1` | Fresh speculative positioning. |
| **`breadth`** | **dispersion of volume across the (strike × expiry) grid** | See below. |

**Operationalizing "matrix breadth":** measure how *spread out* trading is across the chain.
- **Simple (v0.0.1):** `breadth_strikes` = # distinct strikes with volume above a threshold;
  `breadth_expiries` = # distinct expiries active.
- **Principled (later):** normalized **entropy** `H ∈ [0,1]` of the volume distribution over all
  active `(strike, expiry)` cells.
  - **Low breadth** (concentrated) = a single short-dated OTM strike lighting up → the classic
    WSB "lotto" bet; sharp, fragile, gamma-sensitive.
  - **High breadth** (dispersed) = broad speculative interest across the chain → more durable
    positioning.
- The WSB-favorite fingerprint = **low breadth + high `call_vol` + rising `iv_rank`/`iv_skew`**.
  Detecting it is a first-class radar feature.

> **Cost reality:** real-time options Greeks/IV is Polygon/Massive's pricier "Options Advanced"
> tier, and you compute Greeks yourself from the chain. v0.0.1 uses **15-min-delayed** options
> (fine for a non-HFT radar) and the *simple* breadth proxy. See
> [`architecture.md`](./architecture.md).

---

## 4. Normalization — why raw counts lie (do not skip)

Raw `mentions` and raw `vol` are **non-comparable across tickers and across days** (a 10×-busier
sub day inflates everyone; a $2T name always out-volumes a $5B name). Every signal is normalized
before it enters a score:

- **Empirical — `sov` is the primary ranker; `z` is a secondary, cold-start-gated flag.**
  `sov` (a ticker's mentions ÷ all mentions in the window) is **cross-sectional** — it needs no
  history and is honest from day one. `z` vs a per-ticker **hour-of-week** baseline answers "is
  this unusual *for this ticker*?", but a 168-bucket hour-of-week baseline holds only ~1 sample
  per bucket per week, so early `z` turns a 2→6 mention bump into a phantom "+3σ". **Rank on
  `sov` (+ `authors`, `velocity`, `accel`); surface `z` only once a per-(ticker, bucket) sample
  floor is met, weighted by `1/√N` (or use median/MAD), and badge it low-confidence until then.**
  Never rank on raw `mentions`.
- **Analytical:** use `rvol` (vs the ticker's own average), `iv_rank` (percentile), and express
  returns in **vol-units** (`ret / realized_vol`) so a 3% move on a calm name outranks 3% on a
  meme name.
- **Baselines** are trailing *K* weeks, **session-aware** (pre-market / regular / after-hours),
  recomputed rolling, and carry a **`baseline_status`** (cold / warming / ready) so consumers know
  when `z` is trustworthy. The cold-start seeding is in
  [`../sources/reddit-data-access.md`](../sources/reddit-data-access.md).

---

## 5. Composite scores

Two single, rank-able numbers per `(T, W)`, each a weighted blend of standardized
(z/percentile) features so they live on a comparable scale:

- **WSB Heat `H_e`** (empirical, **live**) = weighted blend of
  `{ sov, accel, rank_delta, authors, conviction, |net_dir|, z* }`.
  → "How hot is `T` on WSB right now?" **`sov` carries the primary weight; `z*` enters only when
  its baseline is `ready`** (§4) — until then its weight is zeroed, not faked. **Engagement is
  excluded from the live blend** (scrapers-only; scores lag ~36 h) and folded into a separate
  *settled* `H_e` recomputed post-hoc.
- **Market Heat `H_m`** (analytical) = weighted blend of
  `{ rvol, |ret|/realized_vol, z(call_vol), Δiv_rank, uoa }`.
  → "How much is the market actually moving `T` right now?"

Weights are **tunable config**, not hardcoded; v0.0.1 ships sensible defaults (documented in
the config) and logs the components so weights can be tuned against observed outcomes later.

---

## 6. The product — Attention × Action

The radar's distinctive output is not either heat alone but their **relationship**.

### 6.1 Divergence quadrants
Plot `H_e` (x) against `H_m` (y); split at each one's rolling median:

| | **Market hot (`H_m` high)** | **Market quiet (`H_m` low)** |
|---|---|---|
| **WSB hot (`H_e` high)** | **CONFIRMED** — chatter + action agree. Move is real (and may be *late*). | **HYPE / AHEAD** — loud, no follow-through yet. Watch for breakout or fade. |
| **WSB quiet (`H_e` low)** | **STEALTH / EARLY** — market moving, WSB hasn't noticed. WSB may pile in next. | **QUIET** — ignore. |

- **`divergence = H_e − H_m`** (signed): large +ve = hype ahead of market; large −ve = market
  ahead of WSB.

> **STEALTH is feasible (bounded) on free data — revised 2026-06-03.** Per-ticker market data is
> gated to the WSB-hot list, but Alpaca's free **screeners** (most-actives + movers) are a
> market-wide read (`scripts/probe_alpaca.py`). "Market moving, WSB hasn't noticed" = screener
> movers **∖** the WSB-hot list — discoverable among the **loudest movers** (penny / leveraged-ETF
> noise needs a liquidity filter), though not the full quiet market. Screener data is captured in
> Phase 2 (`market_movers`); STEALTH *detection* lands in Phase 3. A paid full-market snapshot
> would widen coverage. CONFIRMED/HYPE (both gated on WSB heat) already work on free data.

### 6.2 Lead-lag (the defensible insight)
Even in radar mode, **store the `H_e(t)` and `H_m(t)` time-series.** Over a trailing window,
compute the cross-correlation and its argmax lag per ticker → *"on `T`, WSB attention has led
volume by ~`x` hours"* (or lagged). This is the bridge to a future research objective and the
most credible thing the radar can claim.

> **Heavy caveat (causality):** WSB *moves* the small/mid names it discusses (reflexivity, §8
> wallstreetbets.md). A measured "lead" can be **WSB causing the move**, not predicting it — and
> such moves often mean-revert (pump-and-dump shape). The radar reports **association and
> divergence; it does not assert prediction.** This honesty is a feature, not a disclaimer.

---

## 7. Time windows & market sessions

- **Live window:** **1 hour** primary; 15 min during regular hours for finer trending.
- **Rollups:** session (pre-market / RTH / after-hours) and daily.
- **Session skew matters:** WSB chatter peaks **pre-market and after-hours** (Daily / "What Are
  Your Moves Tomorrow" threads) while price/options data is richest during regular hours. Expect
  attention to **lead into the next session** — align everything via session-aware baselines.

---

## 8. The radar output (what the user sees)

1. **Leaderboard** — top-N by `H_e`, columns:
   `ticker | mentions | z | accel | net_dir | H_e ‖ ret | rvol | pcr | iv_rank | breadth | divergence | quadrant`.
2. **Per-ticker drill-down** — `H_e` vs `H_m` time-series, flair breakdown, top posts/DD,
   options snapshot, lead-lag estimate.
3. **Alerts** (optional) — ticker crosses a heat threshold, **flips quadrant**, or shows
   `uoa` + chatter spike *coinciding*.

---

## 9. Validity & confounders (first-class, not footnotes)

From [`../sources/wallstreetbets.md` §8](../sources/wallstreetbets.md): **survivorship bias**
(winners post, losers go quiet), **reflexivity/manipulation** (WSB causes the move), **contrarian
regimes** (euphoria marks tops), **bot/brigade/promo noise**. The framework's responses:
- rank on `sov`/`z`/`authors`, not raw counts or Gain-post counts;
- pair Gain with Loss and with *bets placed* (YOLO/DD), never outcomes alone;
- surface `divergence` and `astroturf` rather than a single "buy" number;
- badge, don't predict.

---

## 10. Build order — v0.0.1 (Phase 0→2), then v0.0.2 (Phase 3)

Do **not** build all of §2–§6 at once. Walking skeleton:

**v0.0.1 (Phase 0→2) — the trending radar + market overlay:**
- **Empirical (live):** rank on **`sov`** (+ `authors`, `velocity`, `accel`); `mentions`,
  `net_dir` (keyword), `flair_counts`, `dd_count`. **`z` is computed but kept off the live
  ranking until its baseline is `ready`** (§4); **warmed forward-only** (no backfill).
  **Engagement (`upvotes`) is post-hoc (>36 h) only**, not in the live leaderboard.
- **Analytical (overlay):** `ret`, `rvol` (low-confidence on free IEX), `call_vol`/`put_vol`/`pcr`,
  `atm_iv`. *Defer:* entropy `breadth` (use `breadth_strikes`), full Greeks, `iv_skew`.
- **Output:** a **minimal Streamlit leaderboard** + JSON (mention/SoV + market overlay).

**v0.0.2 (Phase 3) — the Attention × Action product:**
- **Composite + product:** simple weighted `H_e`, `H_m`; `divergence = H_e − H_m`; **quadrant
  badge** (Confirmed/Hype/Quiet, **plus Stealth** from the captured screener movers ∖ WSB-hot,
  liquidity-filtered — bounded, §6.1); rolling lead-lag; per-ticker drill-down; basic alerts.

**Stub / deferred to Phase 4** (interface only, so it slots in without rework): the **LLM
post-classifier** (`yolo_usd`, `reported_pnl`, win/loss, `is_option_play` — **per-post only, never
aggregated to a per-ticker win rate**; survivorship, §9), `llm_stance`, `astroturf`, `author_cred`.
Phasing in [`../ROADMAP.md`](../ROADMAP.md).
