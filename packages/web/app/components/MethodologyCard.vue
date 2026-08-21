<script setup lang="ts">
// No props — static content ported from dashboard.py METHODOLOGY_MD + EMPIRICAL_GLOSSARY + MARKET_GLOSSARY.
const empiricalGlossary = [
  { column: 'rank', what: 'Board position, hottest first.', formula: 'Rows sorted by H_e, descending.', range: '1…N', lowHigh: 'Just an ordering — #1 is the hottest WSB ticker.' },
  { column: 'ticker', what: 'The stock/ETF symbol mentioned.', formula: 'Extracted from post/comment text: stoplist → whitelist → ambiguous-context gate; a $-cashtag overrides.', range: '—', lowHigh: '—' },
  { column: 'name', what: 'Company / fund name.', formula: 'Looked up from the Alpaca asset list.', range: '—', lowHigh: '—' },
  { column: 'mentions', what: 'Distinct posts + comments naming the ticker this hour.', formula: 'Count of unique (ticker, thing) cells; one thing = one mention even if it repeats the ticker.', range: '≥ 1', lowHigh: 'More air-time. A raw count — NOT the ranker (busy days inflate it).' },
  { column: 'authors', what: 'Distinct accounts that mentioned it.', formula: 'Count of unique usernames (known bots filtered out).', range: '≥ 1', lowHigh: '1 = a single voice (H_e damped); many = broad, robust attention.' },
  { column: 'sov', what: 'Share of voice — the ticker\'s slice of all chatter. THE primary ranker.', formula: 'mentions(ticker) ÷ Σ mentions(all tickers) this window.', range: '0–100%', lowHigh: 'A bigger share of the conversation.' },
  { column: 'velocity', what: 'Change in mentions vs the previous hour (1st derivative).', formula: 'mentions(W) − mentions(W−1). "—" when there is no prior window.', range: 'any integer (can be negative)', lowHigh: 'Negative = fading; positive = chatter building.' },
  { column: 'accel', what: 'Change in velocity (2nd derivative) — the early-breakout signal.', formula: 'velocity(W) − velocity(W−1). "—" when undefined.', range: 'any number (can be negative)', lowHigh: 'Steady/decelerating → surging. Spikes BEFORE sov peaks.' },
  { column: 'z', what: 'How unusual the count is FOR THIS TICKER vs its own norm.', formula: '(mentions − mean) ÷ std-dev over the same hour-of-week history. "—" until baseline is ready.', range: '≈ −3…+3', lowHigh: 'Normal → abnormally chatty for itself. Currently weight 0 (dormant until baselines warm over weeks).' },
  { column: 'net_dir', what: 'Bullish-vs-bearish lean from options/position language.', formula: '(bull − bear) ÷ (bull + bear) over direction words (calls/long vs puts/short). Direction, not ironic sentiment.', range: '−1…+1', lowHigh: '−1 fully bearish · 0 mixed · +1 fully bullish.' },
  { column: 'dd_count', what: 'Number of "DD" (Due Diligence) posts.', formula: 'Count of posts flaired DD this window.', range: '≥ 0', lowHigh: 'More effortful conviction (often leads attention).' },
  { column: 'baseline_status', what: 'Whether z is trustworthy yet.', formula: 'cold (no same-hour history) → warming (some) → ready (≥ min samples).', range: 'cold / warming / ready', lowHigh: 'cold = ignore z; ready = z is trusted.' },
  { column: 'h_e', what: 'WSB Heat — the composite "how hot on WSB right now", and the ranker.', formula: 'Weighted blend of max-normed {sov, accel, rank_delta*, authors, dd, |net_dir|, z}, × support shrink min(1, authors/3). z enters only when ready.', range: '≈ 0–1', lowHigh: 'Cooler → hotter. Thin-support rows are damped toward 0.' },
]

const marketGlossary = [
  { column: 'ret', what: 'Today\'s price return (day-to-date, not window-aligned).', formula: '(latest price − previous close) ÷ previous close.', range: 'typically −20%…+20%', lowHigh: 'Down → up on the day.' },
  { column: 'rvol', what: 'Session-adjusted relative volume.', formula: 'cumulative volume ÷ expected cumulative volume on a generic 9:30–16:00 ET curve, using the ticker\'s trailing average daily volume.', range: '≥ 0  (×1 = normal pace)', lowHigh: '<1 quiet → >1 unusually active. Low-confidence on free IEX; early-close sessions are not calendar-adjusted.' },
  { column: 'h_m', what: 'Market Heat — "how hard the market is actually moving it".', formula: 'Weighted blend of |return| ÷ trailing daily volatility and session-adjusted rvol, each capped on a fixed scale. Never normalized against the current top-N.', range: '0–1', lowHigh: 'Calm → moving hard. Only filled when timestamped evidence exists.' },
]
</script>

<template>
  <UCard class="surface-panel mt-8 rounded-2xl">
    <template #header>
      <h2 class="text-base font-semibold">
        Column &amp; methodology guide
      </h2>
      <p class="text-xs text-muted mt-0.5">
        What each column means and how it's computed.
      </p>
    </template>

    <div class="max-w-none text-sm leading-relaxed text-toned space-y-4">
      <p>
        <strong>The unit is a <code>(ticker, 1-hour window)</code> cell.</strong> Each row is one ticker
        over the current hour, scored by two families: <strong>WSB Heat <code>H_e</code></strong>
        (what the <em>crowd</em> does) and <strong>Market Heat <code>H_m</code></strong>
        (what the <em>market</em> does).
      </p>
      <ul class="list-disc pl-5 space-y-1">
        <li>
          <strong>Ranking is share-of-voice-primary</strong>, never raw mention counts — a busy sub inflates everyone,
          so a ticker's <em>slice</em> of the chatter is the honest signal.
        </li>
        <li>
          <strong>WSB Heat components are max-normalized within the window</strong> (each scaled by
          the window's max, negatives floored to 0), then weighted-blended. Market Heat uses stable
          per-ticker baselines instead, so another ticker entering the top-N cannot rescale it.
        </li>
        <li>
          <strong>Support shrink:</strong> <code>H_e</code> is multiplied by
          <code>min(1, authors / min_authors_full)</code>, so a lone off-hours comment can't
          max-norm its way to the top of the board.
        </li>
        <li>
          <strong>The current hour is provisional.</strong> It is republished as overlapping polls add
          coverage; after one full lateness window, empirical rows and their dependent signals are
          finalized together for historical reads.
        </li>
        <li>
          <strong>"—" means undefined this window</strong> — e.g. <code>velocity</code>/<code>accel</code>
          when there is no prior window (a cold start or a gap in polling), or <code>z</code> before
          its baseline is <code>ready</code>.
        </li>
        <li>
          <strong>Market columns are day-to-date, not window-aligned</strong>
          (<code>H_m</code> answers "hot <em>today</em>", not "hot <em>this hour</em>").
          The header reports the oldest source observation used; <code>H_m</code> stays blank when
          neither return nor relative volume is available, and <code>rvol</code> is low-confidence on IEX.
        </li>
        <li>
          <strong>Quadrants require support:</strong> enough overlaid rows to define the split and at
          least three distinct WSB authors on the individual ticker row.
        </li>
        <li>
          <strong>This measures the attention↔market relationship</strong> — it doesn't predict it.
        </li>
      </ul>

      <h3 class="font-semibold mt-4">
        Empirical — WSB Heat (<code>H_e</code>)
      </h3>
      <div class="overflow-x-auto">
        <table class="text-xs w-full border-collapse">
          <thead>
            <tr class="border-b border-default">
              <th class="text-left py-1 pr-3 font-semibold">Column</th>
              <th class="text-left py-1 pr-3 font-semibold">What it is</th>
              <th class="text-left py-1 pr-3 font-semibold">Formula</th>
              <th class="text-left py-1 pr-3 font-semibold">Range</th>
              <th class="text-left py-1 font-semibold">Low → High</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in empiricalGlossary" :key="row.column" class="border-b border-default/50">
              <td class="py-1 pr-3 font-mono align-top whitespace-nowrap">
                {{ row.column }}
              </td>
              <td class="py-1 pr-3 align-top">
                {{ row.what }}
              </td>
              <td class="py-1 pr-3 align-top text-muted">
                {{ row.formula }}
              </td>
              <td class="py-1 pr-3 align-top whitespace-nowrap">
                {{ row.range }}
              </td>
              <td class="py-1 align-top">
                {{ row.lowHigh }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="font-semibold mt-4">
        Market overlay — Market Heat (<code>H_m</code>)
      </h3>
      <p class="text-xs text-muted">
        Gated to the top-N WSB-hot tickers; blank (—) for everything else.
      </p>
      <div class="overflow-x-auto">
        <table class="text-xs w-full border-collapse">
          <thead>
            <tr class="border-b border-default">
              <th class="text-left py-1 pr-3 font-semibold">Column</th>
              <th class="text-left py-1 pr-3 font-semibold">What it is</th>
              <th class="text-left py-1 pr-3 font-semibold">Formula</th>
              <th class="text-left py-1 pr-3 font-semibold">Range</th>
              <th class="text-left py-1 font-semibold">Low → High</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in marketGlossary" :key="row.column" class="border-b border-default/50">
              <td class="py-1 pr-3 font-mono align-top whitespace-nowrap">
                {{ row.column }}
              </td>
              <td class="py-1 pr-3 align-top">
                {{ row.what }}
              </td>
              <td class="py-1 pr-3 align-top text-muted">
                {{ row.formula }}
              </td>
              <td class="py-1 pr-3 align-top whitespace-nowrap">
                {{ row.range }}
              </td>
              <td class="py-1 align-top">
                {{ row.lowHigh }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="text-xs text-muted mt-3">
        <strong>Market-wide context (below)</strong> is a separate, filtered free-market screener.
        <code>kind</code> is <code>active</code> / <code>gainer</code> / <code>loser</code>; these rows
        are context only and are never promoted to WSB heat or STEALTH labels.
      </p>
    </div>
  </UCard>
</template>
