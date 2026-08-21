<script setup lang="ts">
import type { PlayDetail } from '../../../server/utils/plays'

import { fmtAgo, fmtUtc, fmtUsd, fmtSignedUsd, fmtPctPoints, fmtInt, fmtSov, fmtRet, fmtRvol } from '~/composables/useFormat'
import { useNow } from '~/composables/useNow'
import { flairColor, categoryColor, pnlClass } from '~/utils/play-ui'

// Play detail (product §4.5): screenshot viewer, extracted position table, TLDR + summary,
// interpretation with evidence chips, permalink, versions footer. Outcome chart lands with P5 marks.
const route = useRoute()
const playUrl = computed(() => `/api/plays/${route.params.id}`)
const { data, error, refresh, status } = await useFetch<PlayDetail>(playUrl, { timeout: 10_000 })

// The worker can republish a play (new version) while the page is open — stay within one queue cycle.
useAutoRefresh(data, refresh, 60_000, () => status.value !== 'pending')

const nowSeconds = useNow()

const output = computed(() => data.value?.interpretation?.output ?? null)
const evidence = computed(() => data.value?.interpretation?.evidence ?? null)
const extraction = computed(() => data.value?.extraction?.output ?? null)

const activeImage = ref(0)
watch(playUrl, () => { activeImage.value = 0 })
const currentImage = computed(() =>
  data.value?.play.images[activeImage.value] ?? data.value?.play.images[0] ?? null,
)

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
  <main class="page-shell max-w-7xl space-y-6">
    <nav class="text-sm">
      <NuxtLink to="/" class="inline-flex items-center gap-2 font-semibold text-muted hover:text-primary">
        <UIcon name="i-lucide-arrow-left" class="size-4" />
        Back to the tape
      </NuxtLink>
    </nav>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="error.statusCode === 404 ? 'Play not found' : 'Failed to load play'"
      :description="error.statusCode === 404 ? 'No play with this id — it may not have been captured.' : (error.message ?? 'The server returned an error. Try refreshing.')"
    />

    <template v-if="data">
      <div class="grid gap-7 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] lg:items-start">
        <!-- Primary source stays visible beside the interpretation; galleries use one viewer. -->
        <aside v-if="data.play.images.length" class="space-y-3 lg:sticky lg:top-24">
          <div class="surface-panel relative overflow-hidden rounded-2xl bg-[#0b1117]">
            <img
              v-if="currentImage"
              :src="`/api/media/${currentImage.path}`"
              :alt="`${data.play.title ?? data.play.id} — image ${(currentImage.order ?? 0) + 1}`"
              class="w-full max-h-[calc(100vh-8rem)] min-h-72 object-contain"
            >
            <span class="absolute left-3 top-3 rounded-full bg-black/65 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur">
              Source screenshot
            </span>
          </div>
          <div v-if="data.play.images.length > 1" class="grid grid-cols-5 gap-2" aria-label="Screenshot gallery">
            <button
              v-for="(img, index) in data.play.images"
              :key="img.path"
              type="button"
              class="aspect-square overflow-hidden rounded-lg border bg-[#0b1117] transition"
              :class="activeImage === index ? 'border-primary ring-2 ring-primary/25' : 'border-default hover:border-accented'"
              :aria-label="`Show screenshot ${index + 1}`"
              :aria-pressed="activeImage === index"
              @click="activeImage = index"
            >
              <img
                :src="`/api/media/${img.path}`"
                alt=""
                class="size-full object-cover object-top"
                loading="lazy"
              >
            </button>
          </div>
        </aside>

        <div class="space-y-5" :class="{ 'lg:col-span-2 lg:max-w-4xl': data.play.images.length === 0 }">
          <header class="space-y-4">
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
              <UBadge v-if="data.play.confidence != null" color="neutral" variant="outline">
                {{ (data.play.confidence * 100).toFixed(0) }}% confidence
              </UBadge>
            </div>

            <h1 class="text-2xl sm:text-3xl font-black leading-tight tracking-[-0.035em] text-highlighted">
              {{ data.play.title ?? '(untitled)' }}
            </h1>

            <div class="flex items-center gap-x-3 gap-y-1 flex-wrap text-xs sm:text-sm text-muted">
              <span class="font-semibold text-toned">u/{{ data.play.author ?? '[deleted]' }}</span>
              <span v-if="data.play.createdUtc">
                {{ fmtUtc(data.play.createdUtc) }} UTC<template v-if="nowSeconds"> · {{ fmtAgo(data.play.createdUtc, nowSeconds) }}</template>
              </span>
              <span v-if="data.play.score != null">{{ fmtInt(data.play.score) }} points</span>
              <span v-if="data.play.numComments != null">{{ fmtInt(data.play.numComments) }} comments</span>
              <a
                v-if="data.play.permalink"
                :href="`https://www.reddit.com${data.play.permalink}`"
                target="_blank"
                rel="noopener noreferrer"
                class="font-semibold hover:text-primary"
              >Reddit ↗</a>
            </div>
          </header>

          <!-- Posted P&L is the play's headline, never overwritten by later marks. -->
          <section
            v-if="data.play.primaryTicker || data.play.pnlAbs != null || data.play.pnlPct != null"
            class="surface-panel rounded-2xl p-5 sm:p-6"
          >
            <p class="text-[11px] font-bold uppercase tracking-[0.16em] text-muted">
              Posted P&amp;L
            </p>
            <div class="mt-2 flex items-end justify-between gap-5 flex-wrap">
              <div class="flex items-baseline gap-3 flex-wrap">
                <span v-if="data.play.primaryTicker" class="font-mono text-2xl sm:text-3xl font-black text-highlighted">
                  {{ data.play.primaryTicker }}
                </span>
                <span v-if="data.play.realized != null" class="text-xs font-semibold uppercase tracking-wider text-muted">
                  {{ data.play.realized ? 'realized' : 'open position' }}
                </span>
              </div>
              <div class="text-left sm:text-right">
                <p v-if="data.play.pnlAbs != null" class="text-3xl sm:text-4xl font-black leading-none tabular-nums tracking-tight" :class="pnlClass(data.play.pnlAbs)">
                  {{ fmtSignedUsd(data.play.pnlAbs) }}
                </p>
                <p v-if="data.play.pnlPct != null" class="mt-1.5 text-lg font-bold tabular-nums" :class="pnlClass(data.play.pnlPct)">
                  {{ fmtPctPoints(data.play.pnlPct) }}
                </p>
              </div>
            </div>
            <div class="mt-4 flex items-center justify-between gap-4 border-t border-default pt-3 text-xs text-muted">
              <span>What the original screenshot showed</span>
              <NuxtLink to="/board" class="font-semibold hover:text-primary">Heat context ↗</NuxtLink>
            </div>
          </section>

          <section v-if="output" class="surface-panel rounded-2xl p-5 sm:p-6 space-y-5">
            <div v-if="output.tldr" class="border-l-4 border-primary pl-4">
              <p class="text-xs font-bold uppercase tracking-[0.15em] text-primary mb-1.5">The short version</p>
              <p class="text-lg font-bold leading-snug text-highlighted">{{ output.tldr }}</p>
            </div>
            <p v-if="output.summary" class="text-sm sm:text-base leading-relaxed text-toned whitespace-pre-wrap">
              {{ output.summary }}
            </p>
            <dl class="grid gap-4 sm:grid-cols-2 text-sm">
              <div v-if="output.thesis" class="rounded-xl bg-muted p-4">
                <dt class="font-bold text-[11px] uppercase tracking-[0.14em] text-muted">The bet</dt>
                <dd class="mt-1.5 leading-relaxed">{{ output.thesis }}</dd>
              </div>
              <div v-if="output.outcome" class="rounded-xl bg-muted p-4">
                <dt class="font-bold text-[11px] uppercase tracking-[0.14em] text-muted">How it went</dt>
                <dd class="mt-1.5 leading-relaxed">{{ output.outcome }}</dd>
              </div>
              <div v-if="output.context" class="rounded-xl bg-muted p-4 sm:col-span-2">
                <dt class="font-bold text-[11px] uppercase tracking-[0.14em] text-muted">Context</dt>
                <dd class="mt-1.5 leading-relaxed">{{ output.context }}</dd>
              </div>
            </dl>
            <div v-if="output.tags.length" class="flex items-center gap-1.5 flex-wrap">
              <UBadge v-for="tag in output.tags" :key="tag" color="neutral" variant="outline" size="sm">
                {{ tag }}
              </UBadge>
            </div>
          </section>

          <!-- Evidence chips remain traceable to the stored evidence block (invariant P2). -->
          <section v-if="evidence" class="surface-panel rounded-2xl p-5 sm:p-6 space-y-3">
            <div>
              <p class="text-xs font-bold uppercase tracking-[0.15em] text-primary">Evidence</p>
              <p v-if="evidence.anchor_basis" class="mt-1 text-xs text-muted">
                Anchored at {{ evidence.anchor_basis === 'opened_at' ? 'position open date' : 'post time (weaker: no open date on the screenshot)' }}
              </p>
            </div>
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
            <p v-if="evidence.radar?.note || evidence.market?.note || evidence.note" class="text-xs leading-relaxed text-muted">
              {{ [evidence.note, evidence.radar?.note, evidence.market?.note].filter(Boolean).join(' · ') }}
            </p>
          </section>

          <section
            v-if="data.play.selftext && data.play.selftext !== '[removed]' && data.play.selftext !== '[deleted]'"
            class="surface-panel rounded-2xl p-5 sm:p-6"
          >
            <h2 class="text-xs font-bold uppercase tracking-[0.15em] text-muted">Post text</h2>
            <p class="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-toned">{{ data.play.selftext }}</p>
          </section>
        </div>
      </div>

      <!-- Positions break out full-width; squeezing ten columns into the analysis pane would regress desktop. -->
      <section v-if="extraction && extraction.positions.length" class="surface-panel rounded-2xl p-5 sm:p-6 space-y-4">
        <div class="flex items-baseline gap-2 flex-wrap">
          <h2 class="text-lg font-black text-highlighted">Extracted positions</h2>
          <span class="text-sm text-muted">
            <template v-if="extraction.broker">{{ extraction.broker }}</template>
            <template v-if="extraction.direction"> · {{ extraction.direction }}</template>
          </span>
        </div>

        <div class="hidden md:block overflow-x-auto rounded-xl border border-default">
          <table class="w-full min-w-[64rem] text-sm border-collapse">
            <thead class="bg-muted">
              <tr class="border-b border-default text-[11px] uppercase tracking-wider text-muted">
                <th :class="cellTxt + ' text-left font-bold'">Ticker</th>
                <th :class="cellTxt + ' text-left font-bold'">Instrument</th>
                <th :class="cellTxt + ' text-left font-bold'">Side</th>
                <th :class="cellNum + ' font-bold'">Qty</th>
                <th :class="cellNum + ' font-bold'">Avg</th>
                <th :class="cellNum + ' font-bold'">Cost</th>
                <th :class="cellNum + ' font-bold'">Value</th>
                <th :class="cellNum + ' font-bold'">P&amp;L</th>
                <th :class="cellNum + ' font-bold'">P&amp;L %</th>
                <th :class="cellTxt + ' text-left font-bold'">Status</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in extraction.positions" :key="p.position_id" class="border-b border-default last:border-0">
                <td :class="cellTxt + ' font-mono font-bold text-highlighted'">
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
                <td :class="cellNum + ' font-bold'"><span :class="pnlClass(p.pnl_abs)">{{ fmtSignedUsd(p.pnl_abs) }}</span></td>
                <td :class="cellNum"><span :class="pnlClass(p.pnl_pct)">{{ fmtPctPoints(p.pnl_pct) }}</span></td>
                <td :class="cellTxt + ' text-xs text-muted'">
                  {{ p.realized == null ? '—' : p.realized ? 'closed' : 'open' }}<template v-if="p.opened_at"> · opened {{ p.opened_at }}</template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="grid gap-3 md:hidden">
          <article v-for="p in extraction.positions" :key="p.position_id" class="rounded-xl border border-default bg-muted p-4">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="font-mono text-lg font-black text-highlighted">{{ p.ticker }}</p>
                <p class="text-sm text-muted">{{ instrumentLabel(p) }} · {{ p.side ?? '—' }}</p>
              </div>
              <div class="text-right">
                <p class="font-black tabular-nums" :class="pnlClass(p.pnl_abs)">{{ fmtSignedUsd(p.pnl_abs) }}</p>
                <p class="text-sm font-semibold tabular-nums" :class="pnlClass(p.pnl_pct)">{{ fmtPctPoints(p.pnl_pct) }}</p>
              </div>
            </div>
            <dl class="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div><dt class="text-xs text-muted">Quantity</dt><dd class="tabular-nums">{{ p.quantity ?? '—' }}</dd></div>
              <div><dt class="text-xs text-muted">Average</dt><dd class="tabular-nums">{{ fmtUsd(p.avg_price) }}</dd></div>
              <div><dt class="text-xs text-muted">Cost</dt><dd class="tabular-nums">{{ fmtUsd(p.cost_basis) }}</dd></div>
              <div><dt class="text-xs text-muted">Value</dt><dd class="tabular-nums">{{ fmtUsd(p.current_value) }}</dd></div>
              <div><dt class="text-xs text-muted">Status</dt><dd>{{ p.realized == null ? '—' : p.realized ? 'closed' : 'open' }}</dd></div>
              <div v-if="p.ticker_outcome && p.ticker_outcome !== 'validated'">
                <dt class="text-xs text-muted">Ticker check</dt>
                <dd>{{ p.ticker_outcome === 'known_non_equity' ? 'non-equity' : 'unvalidated' }}</dd>
              </div>
            </dl>
          </article>
        </div>

        <p v-if="extraction.notes" class="text-xs leading-relaxed text-muted">
          Extractor notes: {{ extraction.notes }}
        </p>
      </section>

      <section
        v-if="data.play.status === 'published' && data.play.realized === false"
        class="surface-panel rounded-2xl p-5 sm:p-6"
      >
        <div class="flex items-center gap-3">
          <span class="size-9 rounded-full bg-warning/10 grid place-items-center text-warning">
            <UIcon name="i-lucide-activity" class="size-4" />
          </span>
          <div>
            <h2 class="font-black text-highlighted">Outcome tracking</h2>
            <p class="text-sm text-muted">Open position — daily marks and an outcome chart land with outcome tracking.</p>
          </div>
        </div>
      </section>

      <footer class="rounded-xl border border-default bg-muted px-4 py-3 space-y-1 text-xs text-muted">
        <p v-if="data.extraction">
          extraction: {{ data.extraction.model ?? '?' }} · {{ data.extraction.promptVersion ?? '?' }}
        </p>
        <p v-if="data.interpretation">
          interpretation: {{ data.interpretation.model ?? '?' }} · {{ data.interpretation.promptVersion ?? '?' }}<template v-if="data.play.taxonomyVersion"> · {{ data.play.taxonomyVersion }}</template>
        </p>
        <p>Posted P&amp;L is what the screenshot showed; positions and labels are LLM-extracted and may contain errors.</p>
      </footer>
    </template>
  </main>
</template>
