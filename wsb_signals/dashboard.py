"""WSB Signals — Streamlit dashboard (v0.0.1).

Reads `data/leaderboard.json` (written by `wsb aggregate`). Does NOT touch
DuckDB — the daemon holds the write lock; JSON is the safe read path.

Launch: uv run streamlit run wsb_signals/dashboard.py
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Pure data loader — importable without Streamlit running.
# ---------------------------------------------------------------------------

def load_snapshot(path: Path | str) -> dict[str, Any] | None:
    """Return the parsed leaderboard.json dict, or None if missing/unreadable."""
    try:
        return json.loads(Path(path).read_text())
    except (OSError, json.JSONDecodeError):
        return None


def load_history(path: "Path | str") -> "pd.DataFrame | None":
    """Load history.parquet; return enriched DataFrame or None if unavailable/empty."""
    import pandas as pd
    from wsb_signals.db import pretty_name

    try:
        df = pd.read_parquet(path)
    except (FileNotFoundError, OSError):
        return None
    if df.empty:
        return None
    df = df.copy()
    df["dt"] = pd.to_datetime(df["window_start"], unit="s", utc=True)
    df["date"] = df["dt"].dt.floor("D")
    df["name"] = df["name_raw"].apply(lambda v: pretty_name(v) if isinstance(v, str) else "")
    df["display"] = df.apply(
        lambda r: r["ticker"] + " — " + r["name"] if r["name"] else r["ticker"], axis=1
    )
    return df


def ticker_series(df: "pd.DataFrame", ticker: str, days: "int | None") -> "pd.DataFrame":
    """Return rows for *ticker*, optionally restricted to the last *days* days of data
    (relative to the ticker's latest data point, so the window is deterministic)."""
    import pandas as pd

    ts = df[df["ticker"] == ticker].copy()
    if days is not None and not ts.empty:
        cutoff = ts["dt"].max() - pd.Timedelta(days=days)
        ts = ts[ts["dt"] >= cutoff]
    return ts.sort_values("dt").reset_index(drop=True)


def daily_rollup(df: "pd.DataFrame") -> "pd.DataFrame":
    """Per-day summary: total ticker-mentions, distinct tickers, and the day's top-3 by mentions."""
    import pandas as pd

    records = []
    for date, group in df.groupby("date"):
        top_tickers = group.groupby("ticker")["mentions"].sum().nlargest(3).index.tolist()
        records.append({
            "date": date.strftime("%Y-%m-%d"),
            "top_tickers": ", ".join(top_tickers),
            "total_mentions": int(group["mentions"].sum()),
            "n_tickers": int(group["ticker"].nunique()),
        })
    result = pd.DataFrame(records, columns=["date", "top_tickers", "total_mentions", "n_tickers"])
    return result.sort_values("date", ascending=False).reset_index(drop=True)


def style_heatmap(pivot: "pd.DataFrame", fmt_str: str):
    """Blue gradient + number format for the trends heatmap. Hand-rolled colormap so we don't pull
    in matplotlib just for Styler.background_gradient: each cell's alpha ramps with where its value
    sits between the pivot's global min/max; NaN cells stay blank."""
    import pandas as pd

    vals = pivot.to_numpy(dtype="float64", na_value=float("nan"))
    finite = vals[~pd.isna(vals)]
    vmin = float(finite.min()) if finite.size else 0.0
    vmax = float(finite.max()) if finite.size else 1.0
    span = (vmax - vmin) or 1.0

    def _cell(v):
        if v is None or (isinstance(v, float) and pd.isna(v)):
            return ""
        alpha = 0.10 + 0.80 * (float(v) - vmin) / span
        return f"background-color: rgba(31, 119, 180, {alpha:.3f}); color: {'white' if alpha > 0.55 else 'inherit'}"

    styler = pivot.style
    paint = getattr(styler, "map", None) or styler.applymap  # pandas ≥2.1 renamed applymap→map
    return paint(_cell).format(fmt_str, na_rep="")


def heatmap_pivot(df: "pd.DataFrame", metric: str, top_k: int) -> "pd.DataFrame":
    """Pivot top_k tickers × daily aggregate of *metric* into a heatmap DataFrame."""
    import pandas as pd

    agg_fn = "sum" if metric == "mentions" else "max"
    daily = df.groupby(["ticker", "date"])[metric].agg(agg_fn).reset_index()
    daily["date_str"] = daily["date"].apply(lambda d: d.strftime("%Y-%m-%d"))

    totals = daily.groupby("ticker")[metric].sum()
    top_tickers = totals.nlargest(top_k).index.tolist()
    daily = daily[daily["ticker"].isin(top_tickers)]

    pivot = daily.pivot(index="ticker", columns="date_str", values=metric)
    pivot.columns.name = None
    pivot = pivot[sorted(pivot.columns)]  # ascending date columns

    # Order rows by total descending
    row_order = daily.groupby("ticker")[metric].sum().reindex(top_tickers).sort_values(ascending=False).index
    pivot = pivot.reindex(row_order)
    return pivot


# ---------------------------------------------------------------------------
# Streamlit app — only executed when Streamlit imports the module as a script.
# ---------------------------------------------------------------------------

def _fmt_utc(epoch: int | float, fmt: str = "%Y-%m-%d %H:%M") -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime(fmt)


# ---------------------------------------------------------------------------
# Column & methodology glossary — plain data (no Streamlit), so it stays
# importable/testable and documents the signal-framework in one place.
# Keys are the table headers; "Column" becomes the row label when rendered.
# ---------------------------------------------------------------------------

METHODOLOGY_MD = """\
**The unit is a `(ticker, 1-hour window)` cell.** Each row is one ticker over the current hour,
scored by two families: **WSB Heat `H_e`** (what the *crowd* does) and **Market Heat `H_m`**
(what the *market* does).

- **Ranking is share-of-voice-primary**, never raw mention counts — a busy sub inflates everyone,
  so a ticker's *slice* of the chatter is the honest signal.
- **Components are max-normalized within the window** (each scaled by the window's max, negatives
  floored to 0), then weighted-blended — so they share a comparable `[0, 1]` scale before mixing.
- **Support shrink:** `H_e` is multiplied by `min(1, authors / min_authors_full)`, so a lone
  off-hours comment can't max-norm its way to the top of the board.
- **"—" means undefined this window** — e.g. `velocity`/`accel` when there is no prior window
  (a cold start or a gap in polling), or `z` before its baseline is `ready`.
- **Market columns are day-to-date, not window-aligned** (`H_m` answers "hot *today*", not "hot
  *this hour*"); `rvol` is low-confidence on the free IEX feed.
- **Not financial advice.** This measures the attention↔market relationship; it doesn't predict it.
  Divergence quadrants, STEALTH, and lead-lag arrive in v0.0.2.
"""

EMPIRICAL_GLOSSARY = [
    {"Column": "rank", "What it is": "Board position, hottest first.",
     "Formula": "Rows sorted by H_e, descending.", "Range": "1…N",
     "Low → High": "Just an ordering — #1 is the hottest WSB ticker.", "Related to": "H_e"},
    {"Column": "ticker", "What it is": "The stock/ETF symbol mentioned.",
     "Formula": "Extracted from post/comment text: stoplist → whitelist → ambiguous-context gate; a $-cashtag overrides.",
     "Range": "—", "Low → High": "—", "Related to": "name"},
    {"Column": "name", "What it is": "Company / fund name.",
     "Formula": "Looked up from the Alpaca asset list.", "Range": "—", "Low → High": "—",
     "Related to": "ticker"},
    {"Column": "mentions", "What it is": "Distinct posts + comments naming the ticker this hour.",
     "Formula": "Count of unique (ticker, thing) cells; one thing = one mention even if it repeats the ticker.",
     "Range": "≥ 1", "Low → High": "More air-time. A raw count — NOT the ranker (busy days inflate it).",
     "Related to": "sov, velocity"},
    {"Column": "authors", "What it is": "Distinct accounts that mentioned it.",
     "Formula": "Count of unique usernames (known bots filtered out).", "Range": "≥ 1",
     "Low → High": "1 = a single voice (H_e damped); many = broad, robust attention.",
     "Related to": "H_e support shrink"},
    {"Column": "sov", "What it is": "Share of voice — the ticker's slice of all chatter. THE primary ranker.",
     "Formula": "mentions(ticker) ÷ Σ mentions(all tickers) this window.", "Range": "0–100%",
     "Low → High": "A bigger share of the conversation. (In a quiet window 20% can be 1 of 5 — see the quiet banner.)",
     "Related to": "H_e (largest weight)"},
    {"Column": "velocity", "What it is": "Change in mentions vs the previous hour (1st derivative).",
     "Formula": "mentions(W) − mentions(W−1).  '—' when there is no prior window.",
     "Range": "any integer (can be negative)",
     "Low → High": "Negative = fading; positive = chatter building. Needs continuous polling to mean anything.",
     "Related to": "accel"},
    {"Column": "accel", "What it is": "Change in velocity (2nd derivative) — the early-breakout signal.",
     "Formula": "velocity(W) − velocity(W−1).  '—' when undefined.", "Range": "any number (can be negative)",
     "Low → High": "Steady/decelerating → surging. Spikes BEFORE sov peaks. (Negative is floored to 0 in H_e.)",
     "Related to": "velocity, H_e"},
    {"Column": "z", "What it is": "How unusual the count is FOR THIS TICKER vs its own norm.",
     "Formula": "(mentions − mean) ÷ std-dev over the same hour-of-week history.  '—' until baseline is ready.",
     "Range": "≈ −3…+3", "Low → High": "Normal → abnormally chatty for itself. Currently weight 0 (dormant until baselines warm over weeks).",
     "Related to": "baseline_status"},
    {"Column": "net_dir", "What it is": "Bullish-vs-bearish lean from options/position language.",
     "Formula": "(bull − bear) ÷ (bull + bear) over direction words (calls/long vs puts/short). Direction, not ironic sentiment.",
     "Range": "−1…+1", "Low → High": "−1 fully bearish · 0 mixed · +1 fully bullish.",
     "Related to": "H_e uses |net_dir| (conviction strength, either side)"},
    {"Column": "dd_count", "What it is": "Number of 'DD' (Due Diligence) posts.",
     "Formula": "Count of posts flaired DD this window.", "Range": "≥ 0",
     "Low → High": "More effortful conviction (often leads attention).", "Related to": "H_e (conviction)"},
    {"Column": "baseline_status", "What it is": "Whether z is trustworthy yet.",
     "Formula": "cold (no same-hour history) → warming (some) → ready (≥ min samples).",
     "Range": "cold / warming / ready", "Low → High": "cold = ignore z; ready = z is trusted.",
     "Related to": "z"},
    {"Column": "h_e", "What it is": "WSB Heat — the composite 'how hot on WSB right now', and the ranker.",
     "Formula": "Weighted blend of max-normed {sov, accel, rank_delta*, authors, dd, |net_dir|, z}, × support shrink min(1, authors/3). z enters only when ready.  (*rank_delta = SoV places climbed vs last hour.)",
     "Range": "≈ 0–1", "Low → High": "Cooler → hotter. Thin-support rows are damped toward 0.",
     "Related to": "every column above"},
]

MARKET_GLOSSARY = [
    {"Column": "ret", "What it is": "Today's price return (day-to-date, not window-aligned).",
     "Formula": "(latest price − previous close) ÷ previous close.", "Range": "typically −20%…+20%",
     "Low → High": "Down → up on the day.", "Related to": "H_m uses |ret|"},
    {"Column": "rvol", "What it is": "Relative volume — today's volume vs a normal day.",
     "Formula": "day volume ÷ previous full-day volume. Low-confidence on free IEX; structurally small early in the session.",
     "Range": "≥ 0  (×1 = normal)", "Low → High": "<1 quiet → >1 unusually active. The market twin of sov/z.",
     "Related to": "H_m"},
    {"Column": "h_m", "What it is": "Market Heat — 'how hard the market is actually moving it'.",
     "Formula": "Weighted blend of max-normed {|ret|, rvol}. Put/call + IV join with the options increment.",
     "Range": "≈ 0–1", "Low → High": "Calm → moving hard. Only filled for the top-N WSB-hot tickers.",
     "Related to": "ret, rvol"},
]


def main() -> None:
    import pandas as pd
    import streamlit as st

    # Absolute import: `streamlit run dashboard.py` executes this as a top-level
    # script (no package context), so a relative `from .config` would fail.
    from wsb_signals.config import Settings

    st.set_page_config(page_title="WSB Signals", layout="wide")
    st.title("WSB Signals — trending radar (v0.0.1)")

    # Refresh button — Streamlit reruns the whole script on click, re-reading the file.
    st.button("Refresh")

    s = Settings.load()
    snap = load_snapshot(s.data_dir / "leaderboard.json")
    hist = load_history(s.data_dir / "history.parquet")

    tab_live, tab_ticker, tab_trends, tab_daily = st.tabs(
        ["Live", "Ticker history", "Trends", "Daily rollup"]
    )

    # ------------------------------------------------------------------
    # Tab: Live board
    # ------------------------------------------------------------------
    with tab_live:
        if snap is None or not snap.get("rows"):
            st.info(
                "No snapshot data found. Run `uv run wsb run` or `uv run wsb aggregate` "
                "to generate `data/leaderboard.json`, then refresh."
            )
        else:
            # --- window header ---
            w_start = snap["window_start"]
            w_end = snap["window_end"]
            gen_at = snap["generated_at"]
            n_tickers = len(snap["rows"])

            # Format: "Window: 2026-06-03 19:00–20:00 UTC · 42 tickers · generated 20:05 UTC"
            start_str = _fmt_utc(w_start, "%Y-%m-%d %H:%M")
            end_str = _fmt_utc(w_end, "%H:%M")
            gen_str = _fmt_utc(gen_at, "%H:%M")
            total_mentions = snap.get("total_mentions")
            mentions_str = f" · {total_mentions} mentions" if total_mentions is not None else ""
            st.subheader(
                f"Window: {start_str}–{end_str} UTC · {n_tickers} tickers{mentions_str} · generated {gen_str} UTC"
            )

            # Quiet-window guard: off-hours a handful of single mentions fill the board; H_e is damped
            # but the *ordering* is still low-information. Say so rather than imply a confident ranking.
            if snap.get("quiet"):
                st.warning(
                    f"**Quiet window** — only {total_mentions} total mentions. Rankings are low-confidence "
                    "(thin-support rows are damped, but small-sample noise dominates off-hours)."
                )

            # --- build DataFrame ---
            COLS = ["rank", "ticker", "name", "mentions", "authors", "sov", "velocity",
                    "accel", "z", "net_dir", "dd_count", "baseline_status", "h_e"]
            MARKET_COLS = ["ret", "rvol", "h_m"]

            rows = snap["rows"]
            df = pd.DataFrame(rows)
            # Ensure optional columns exist (may be absent from older snapshots).
            for col in MARKET_COLS + ["name"]:
                if col not in df.columns:
                    df[col] = None
            df = df[COLS + MARKET_COLS]

            def _null_fmt(v, fmt_fn):
                """Return formatted string or '—' for None/NaN."""
                if v is None or (isinstance(v, float) and pd.isna(v)):
                    return "—"
                return fmt_fn(v)

            # Format display columns (operate on string copies; don't mutate numeric cols).
            display = df.copy()
            display["sov"] = df["sov"].apply(lambda v: f"{v * 100:.1f}%")
            display["velocity"] = df["velocity"].apply(lambda v: _null_fmt(v, lambda x: f"{x:.2f}"))
            display["accel"] = df["accel"].apply(lambda v: _null_fmt(v, lambda x: f"{x:.2f}"))
            display["net_dir"] = df["net_dir"].round(2)
            display["h_e"] = df["h_e"].round(2)
            display["z"] = df["z"].apply(lambda v: _null_fmt(v, lambda x: f"{x:.2f}"))
            display["ret"] = df["ret"].apply(lambda v: _null_fmt(v, lambda x: f"{x * 100:+.1f}%"))
            display["rvol"] = df["rvol"].apply(lambda v: _null_fmt(v, lambda x: f"×{x:.2f}"))
            display["h_m"] = df["h_m"].apply(lambda v: _null_fmt(v, lambda x: f"{x:.2f}"))

            st.dataframe(display, width="stretch", hide_index=True)

            # --- footnote ---
            st.caption(
                "Ranked by H_e (SoV-primary). Market overlay (ret/rvol/H_m) is **day-to-date**, "
                "not aligned to the 1h WSB window (a v0.0.1 simplification — H_m answers 'hot today', "
                "not 'hot this hour'); rvol is low-confidence on free IEX volume and structurally small "
                "early in the session. Divergence quadrants, lead-lag, and STEALTH detection are Phase 3 (v0.0.2)."
            )

            # --- column & methodology guide (collapsed; one click from the board) ---
            with st.expander("ℹ️ Column & methodology guide — what each column means and how it's computed"):
                st.markdown(METHODOLOGY_MD)
                st.markdown("##### Empirical — WSB Heat (`H_e`)")
                st.table(pd.DataFrame(EMPIRICAL_GLOSSARY).set_index("Column"))
                st.markdown("##### Market overlay — Market Heat (`H_m`)")
                st.markdown("Gated to the top-N WSB-hot tickers; blank (`—`) for everything else.")
                st.table(pd.DataFrame(MARKET_GLOSSARY).set_index("Column"))
                st.markdown(
                    "**Market movers table (below)** is the free market-wide screener — `kind` is "
                    "`active` / `gainer` / `loser`. These are STEALTH candidates for v0.0.2: names the "
                    "market is moving that WSB may not have noticed yet."
                )

            # --- movers section ---
            movers = snap.get("movers")
            if movers:
                st.subheader("Market movers (free screener — STEALTH candidates for v0.0.2)")

                def _pct_fmt(v):
                    return _null_fmt(v, lambda x: f"{x:+.1f}%")

                movers_display = pd.DataFrame(movers)
                for col in ["symbol", "name", "kind", "percent_change", "price", "volume"]:
                    if col not in movers_display.columns:
                        movers_display[col] = None
                movers_display = movers_display[["symbol", "name", "kind", "percent_change", "price", "volume"]]
                # Format every numeric column to a uniform STRING dtype. Returning raw floats here
                # left mixed str/float ("—" + 123.45) object columns that pyarrow can't serialize
                # cleanly (Streamlit logs an ArrowTypeError + silently auto-coerces). Strings are safe.
                movers_display["percent_change"] = movers_display["percent_change"].apply(_pct_fmt)
                movers_display["price"] = movers_display["price"].apply(lambda v: _null_fmt(v, lambda x: f"{x:,.2f}"))
                movers_display["volume"] = movers_display["volume"].apply(lambda v: _null_fmt(v, lambda x: f"{int(x):,}"))

                st.dataframe(movers_display, width="stretch", hide_index=True)

    # ------------------------------------------------------------------
    # Tab: Ticker history (drill-down)
    # ------------------------------------------------------------------
    with tab_ticker:
        if hist is None:
            st.info(
                "No history yet — the radar writes data/history.parquet each cycle once it's "
                "collecting. Check back after a few cycles."
            )
        else:
            # Build display labels for the selectbox
            label_map = (
                hist[["ticker", "display"]]
                .drop_duplicates("ticker")
                .set_index("ticker")["display"]
                .to_dict()
            )
            sorted_tickers = sorted(label_map.keys())
            sorted_labels = [label_map[t] for t in sorted_tickers]

            chosen_label = st.selectbox("Ticker", options=sorted_labels)
            chosen_ticker = sorted_tickers[sorted_labels.index(chosen_label)]

            range_opt = st.radio(
                "Range", options=["7d", "30d", "90d", "All"], index=1, horizontal=True
            )
            days_map = {"7d": 7, "30d": 30, "90d": 90, "All": None}
            days = days_map[range_opt]

            ts = ticker_series(hist, chosen_ticker, days)

            c1, c2, c3 = st.columns(3)
            c1.metric("# hourly windows", len(ts))
            peak_he = ts["h_e"].max() if not ts.empty else float("nan")
            c2.metric("Peak H_e", f"{peak_he:.2f}" if not pd.isna(peak_he) else "—")
            latest_sov = ts["sov"].iloc[-1] if not ts.empty else float("nan")
            c3.metric("Latest SoV", f"{latest_sov * 100:.1f}%" if not pd.isna(latest_sov) else "—")

            if not ts.empty:
                he_hm = ts.set_index("dt")[["h_e", "h_m"]].rename(columns={"h_e": "H_e", "h_m": "H_m"})
                st.line_chart(he_hm)
                st.bar_chart(ts.set_index("dt")[["mentions"]])
                st.caption(
                    "H_m is sparse — it is only populated for hours when this ticker was in the "
                    "market top-N screener. Gaps in the H_m line are expected."
                )

    # ------------------------------------------------------------------
    # Tab: Trends (heatmap)
    # ------------------------------------------------------------------
    with tab_trends:
        if hist is None:
            st.info(
                "No history yet — the radar writes data/history.parquet each cycle once it's "
                "collecting. Check back after a few cycles."
            )
        else:
            metric_opt = st.radio(
                "Metric", options=["H_e", "SoV", "mentions"], horizontal=True
            )
            metric_map = {"H_e": "h_e", "SoV": "sov", "mentions": "mentions"}
            metric = metric_map[metric_opt]

            top_k = st.slider("Tickers", min_value=5, max_value=30, value=15)

            pivot = heatmap_pivot(hist, metric, top_k)

            fmt_str = "{:.0f}" if metric == "mentions" else "{:.3f}"
            st.dataframe(style_heatmap(pivot, fmt_str))
            st.caption(
                "Rows = top tickers by total aggregate; columns = days (ascending). "
                "Shade = that day's peak (H_e/SoV) or sum (mentions). NaN = no mentions that day."
            )

    # ------------------------------------------------------------------
    # Tab: Daily rollup
    # ------------------------------------------------------------------
    with tab_daily:
        if hist is None:
            st.info(
                "No history yet — the radar writes data/history.parquet each cycle once it's "
                "collecting. Check back after a few cycles."
            )
        else:
            st.dataframe(daily_rollup(hist), hide_index=True, width="stretch")
            st.caption(
                "total_mentions = sum of all ticker-mentions on that day; "
                "n_tickers = distinct tickers seen that day."
            )


if __name__ == "__main__":
    # `streamlit run` sets __name__ == "__main__", so this fires when Streamlit
    # executes the file but NOT when another module does `from .dashboard import
    # load_snapshot` — keeping the pure loader importable without Streamlit.
    main()
