<script setup lang="ts">
import { fmtAgo, fmtUtc, fmtUsd, fmtSignedUsd, fmtPctPoints, fmtInt, fmtSov, fmtRet, fmtRvol } from '~/composables/useFormat'
import { useNow } from '~/composables/useNow'
import { flairColor, categoryColor, pnlClass } from '~/utils/play-ui'

// Play detail (product §4.5): screenshot viewer, extracted position table, TLDR + summary,
// interpretation with evidence chips, permalink, versions footer. Outcome chart lands with P5 marks.
const route = useRoute()
const { data, error } = await useFetch(`/api/plays/${route.params.id}`)

const nowSeconds = useNow()

const output = computed(() => data.value?.interpretation?.output ?? null)
const evidence = computed(() => data.value?.interpretation?.evidence ?? null)
const extraction = computed(() => data.value?.extraction?.output ?? null)

/** "call 250 · 2026-09-18" / "put 5 (no expiry)" / "shares" — one compact instrument cell. */
const instrumentLabel = (p: { instrument: string, strike: number | null, expiry: string | null }): string => {
  if (p.instrument !== 'call' && p.instrument !== 'put') return p.instrument
  const strike = p.strike != null ? ` ${p.strike}` : ''
  const expiry = p.expiry ? ` · ${p.expiry}` : ''
  return `${p.instrument}${strike}${expiry}`
}

const cellNum = 'px-2 py-1.5 text-right tabular-nums'
const cellTxt = 'px-2 py-1.5'
</script>

<template>
  <main class="max-w-4xl mx-auto px-4 py-8 space-y-6">
    <nav class="text-sm text-muted">
      <NuxtLink to="/plays" class="hover:text-highlighted">← Plays</NuxtLink>
    </nav>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="error.statusCode === 404 ? 'Play not found' : 'Failed to load play'"
      :description="error.statusCode === 404 ? 'No play with this id — it may not have been captured.' : (error.message ?? 'The server returned an error. Try refreshing.')"
    />

    <template v-if="data">
      <!-- Header -->
      <div class="space-y-2">
        <div class="flex items-center gap-2 flex-wrap">
          <UBadge :color="flairColor(data.play.flair)" variant="subtle">
            {{ data.play.flair ?? '—' }}
          </UBadge>
          <UBadge v-if="data.play.category" :color="categoryColor(data.play.category)" variant="subtle">
            {{ data.play.category }}
          </UBadge>
          <UBadge v-if="data.play.status !== 'published'" color="neutral" variant="subtle">
            {{ data.play.status }}
          </UBadge>
          <span v-if="data.play.confidence != null" class="text-xs text-muted">
            confidence {{ (data.play.confidence * 100).toFixed(0) }}%
          </span>
        </div>
        <h1 class="text-xl font-bold">
          {{ data.play.title ?? '(untitled)' }}
        </h1>
        <p class="text-sm text-muted">
          u/{{ data.play.author ?? '[deleted]' }}
          <template v-if="data.play.createdUtc">
            · {{ fmtUtc(data.play.createdUtc) }} UTC<template v-if="nowSeconds"> ({{ fmtAgo(data.play.createdUtc, nowSeconds) }})</template>
          </template>
          <template v-if="data.play.score != null">
            · {{ fmtInt(data.play.score) }} points
          </template>
          <template v-if="data.play.numComments != null">
            · {{ fmtInt(data.play.numComments) }} comments
          </template>
          <a
            v-if="data.play.permalink"
            :href="`https://www.reddit.com${data.play.permalink}`"
            target="_blank"
            rel="noopener noreferrer"
            class="underline hover:text-highlighted"
          >· reddit ↗</a>
        </p>
      </div>

      <!-- Posted P&L headline -->
      <div v-if="data.play.primaryTicker || data.play.pnlAbs != null || data.play.pnlPct != null" class="flex items-baseline gap-3 flex-wrap">
        <span v-if="data.play.primaryTicker" class="font-mono font-bold text-2xl">{{ data.play.primaryTicker }}</span>
        <span v-if="data.play.pnlAbs != null" class="text-2xl font-bold tabular-nums" :class="pnlClass(data.play.pnlAbs)">
          {{ fmtSignedUsd(data.play.pnlAbs) }}
        </span>
        <span v-if="data.play.pnlPct != null" class="text-lg tabular-nums" :class="pnlClass(data.play.pnlPct)">
          {{ fmtPctPoints(data.play.pnlPct) }}
        </span>
        <span v-if="data.play.realized != null" class="text-sm text-muted">
          {{ data.play.realized ? 'realized' : 'open position' }}
        </span>
        <span class="text-xs text-muted">posted P&L — what the screenshot showed</span>
      </div>

      <!-- Interpretation -->
      <section v-if="output" class="space-y-3">
        <p v-if="output.tldr" class="text-base font-medium">
          {{ output.tldr }}
        </p>
        <p v-if="output.summary" class="text-sm whitespace-pre-wrap">
          {{ output.summary }}
        </p>
        <dl class="space-y-2 text-sm">
          <div v-if="output.thesis">
            <dt class="font-semibold text-xs uppercase tracking-wide text-muted">The bet</dt>
            <dd>{{ output.thesis }}</dd>
          </div>
          <div v-if="output.outcome">
            <dt class="font-semibold text-xs uppercase tracking-wide text-muted">How it went</dt>
            <dd>{{ output.outcome }}</dd>
          </div>
          <div v-if="output.context">
            <dt class="font-semibold text-xs uppercase tracking-wide text-muted">Context</dt>
            <dd>{{ output.context }}</dd>
          </div>
        </dl>
        <div v-if="output.tags.length" class="flex items-center gap-1.5 flex-wrap">
          <UBadge v-for="tag in output.tags" :key="tag" color="neutral" variant="outline" size="sm">
            {{ tag }}
          </UBadge>
        </div>
      </section>

      <!-- Positions -->
      <section v-if="extraction && extraction.positions.length" class="space-y-2">
        <h2 class="text-sm font-semibold">
          Extracted positions
          <span class="font-normal text-muted">
            <template v-if="extraction.broker">— {{ extraction.broker }}</template>
            <template v-if="extraction.direction"> · {{ extraction.direction }}</template>
          </span>
        </h2>
        <div class="overflow-x-auto">
          <table class="w-full text-sm border-collapse">
            <thead>
              <tr class="border-b border-default text-xs text-muted">
                <th :class="cellTxt + ' text-left font-medium'">Ticker</th>
                <th :class="cellTxt + ' text-left font-medium'">Instrument</th>
                <th :class="cellTxt + ' text-left font-medium'">Side</th>
                <th :class="cellNum + ' font-medium'">Qty</th>
                <th :class="cellNum + ' font-medium'">Avg</th>
                <th :class="cellNum + ' font-medium'">Cost</th>
                <th :class="cellNum + ' font-medium'">Value</th>
                <th :class="cellNum + ' font-medium'">P&L</th>
                <th :class="cellNum + ' font-medium'">P&L %</th>
                <th :class="cellTxt + ' text-left font-medium'">Status</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in extraction.positions" :key="p.position_id" class="border-b border-default">
                <td :class="cellTxt + ' font-mono font-semibold'">
                  {{ p.ticker }}
                  <UBadge v-if="p.ticker_outcome && p.ticker_outcome !== 'validated'" color="warning" variant="subtle" size="sm">
                    {{ p.ticker_outcome === 'known_non_equity' ? 'non-equity' : 'unvalidated' }}
                  </UBadge>
                </td>
                <td :class="cellTxt">{{ instrumentLabel(p) }}</td>
                <td :class="cellTxt">{{ p.side ?? '—' }}</td>
                <td :class="cellNum">{{ p.quantity ?? '—' }}</td>
                <td :class="cellNum">{{ fmtUsd(p.avg_price) }}</td>
                <td :class="cellNum">{{ fmtUsd(p.cost_basis) }}</td>
                <td :class="cellNum">{{ fmtUsd(p.current_value) }}</td>
                <td :class="cellNum" class="font-medium">
                  <span :class="pnlClass(p.pnl_abs)">{{ fmtSignedUsd(p.pnl_abs) }}</span>
                </td>
                <td :class="cellNum">
                  <span :class="pnlClass(p.pnl_pct)">{{ fmtPctPoints(p.pnl_pct) }}</span>
                </td>
                <td :class="cellTxt + ' text-xs text-muted'">
                  {{ p.realized == null ? '—' : p.realized ? 'closed' : 'open' }}<template v-if="p.opened_at"> · opened {{ p.opened_at }}</template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="extraction.notes" class="text-xs text-muted">
          extractor notes: {{ extraction.notes }}
        </p>
      </section>

      <!-- Evidence chips (invariant P2 — each traceable to the stored evidence block) -->
      <section v-if="evidence" class="space-y-2">
        <h2 class="text-sm font-semibold">
          Evidence
          <span v-if="evidence.anchor_basis" class="font-normal text-muted">
            — anchored at {{ evidence.anchor_basis === 'opened_at' ? 'position open date' : 'post time (weaker: no open date on the screenshot)' }}
          </span>
        </h2>
        <div class="flex items-center gap-1.5 flex-wrap text-xs">
          <UBadge v-if="evidence.radar?.heat?.rank != null" color="info" variant="subtle">
            heat rank #{{ evidence.radar.heat.rank }}
          </UBadge>
          <UBadge v-else-if="evidence.radar" color="neutral" variant="subtle">
            not on the heat board
          </UBadge>
          <UBadge v-if="evidence.radar?.heat?.sov != null" color="info" variant="subtle">
            SoV {{ fmtSov(evidence.radar.heat.sov) }}
          </UBadge>
          <UBadge v-if="evidence.radar" color="neutral" variant="subtle">
            {{ fmtInt(evidence.radar.mentions_24h) }} mentions / {{ fmtInt(evidence.radar.authors_24h) }} authors (24h)
          </UBadge>
          <UBadge v-if="evidence.herd?.distinct_authors != null" :color="evidence.herd.eligible ? 'warning' : 'neutral'" variant="subtle">
            herd: {{ evidence.herd.distinct_authors }} same-direction authors{{ evidence.herd.threshold != null ? ` (threshold ${evidence.herd.threshold})` : '' }}
          </UBadge>
          <UBadge v-if="evidence.market?.day_ret != null" :color="evidence.market.day_ret >= 0 ? 'success' : 'error'" variant="subtle">
            day {{ fmtRet(evidence.market.day_ret) }}
          </UBadge>
          <UBadge v-if="evidence.market?.five_day_ret != null" color="neutral" variant="subtle">
            5d {{ fmtRet(evidence.market.five_day_ret) }}
          </UBadge>
          <UBadge v-if="evidence.market?.rvol != null" color="neutral" variant="subtle">
            rvol {{ fmtRvol(evidence.market.rvol) }}{{ evidence.market.rvol_conf === 'low' ? ' (low conf)' : '' }}
          </UBadge>
          <UBadge v-for="m in evidence.market?.movers ?? []" :key="m" color="info" variant="subtle">
            movers: {{ m }}
          </UBadge>
        </div>
        <p v-if="evidence.radar?.note || evidence.market?.note || evidence.note" class="text-xs text-muted">
          {{ [evidence.note, evidence.radar?.note, evidence.market?.note].filter(Boolean).join(' · ') }}
        </p>
      </section>

      <!-- Screenshots -->
      <section v-if="data.play.images.length" class="space-y-3">
        <h2 class="text-sm font-semibold">
          Screenshots
        </h2>
        <img
          v-for="img in data.play.images"
          :key="img.path"
          :src="`/api/media/${img.path}`"
          :alt="`${data.play.title ?? data.play.id} — image ${img.order ?? ''}`"
          class="w-full rounded-lg border border-default bg-elevated"
          loading="lazy"
        >
      </section>

      <!-- Self text (removal markers render nothing — the tombstone badge already says it) -->
      <section v-if="data.play.selftext && data.play.selftext !== '[removed]' && data.play.selftext !== '[deleted]'" class="space-y-2">
        <h2 class="text-sm font-semibold">
          Post text
        </h2>
        <p class="text-sm whitespace-pre-wrap text-muted">
          {{ data.play.selftext }}
        </p>
      </section>

      <!-- Footer: provenance + disclaimer -->
      <footer class="pt-4 border-t border-default space-y-1 text-xs text-muted">
        <p v-if="data.extraction">
          extraction: {{ data.extraction.model ?? '?' }} · {{ data.extraction.promptVersion ?? '?' }}
        </p>
        <p v-if="data.interpretation">
          interpretation: {{ data.interpretation.model ?? '?' }} · {{ data.interpretation.promptVersion ?? '?' }}<template v-if="data.play.taxonomyVersion"> · {{ data.play.taxonomyVersion }}</template>
        </p>
        <p>
          Posted P&L is what the screenshot showed; positions and labels are LLM-extracted and may
          contain errors.
        </p>
      </footer>
    </template>
  </main>
</template>
