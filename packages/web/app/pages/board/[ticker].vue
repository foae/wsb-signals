<script setup lang="ts">
import type { HeatPoint } from '~/types/heat'
import { fmt2, fmtInt, fmtRankDelta, fmtRet, fmtRvol, fmtSov, fmtUtc } from '~/composables/useFormat'

const route = useRoute()
const ticker = String(route.params.ticker ?? '').toUpperCase()
const { data, error } = await useFetch(`/api/heat/tickers/${encodeURIComponent(ticker)}`)

useHead({ title: `${ticker} Heat History — WSB Plays` })

const observed = computed(() => (data.value?.heat ?? []).filter((point) => point.hE != null))
const latest = computed(() => observed.value.at(-1) ?? null)
const history = computed(() => [...observed.value].reverse())

const chart = { width: 720, height: 230, left: 42, right: 14, top: 14, bottom: 30 }
const plotWidth = chart.width - chart.left - chart.right
const plotHeight = chart.height - chart.top - chart.bottom

function pathFor(key: 'hE' | 'hM'): string {
  const points = data.value?.heat ?? []
  if (!points.length) return ''
  const from = points[0]!.windowStart
  const to = points.at(-1)!.windowStart
  const span = Math.max(1, to - from)
  let path = ''
  let drawing = false
  for (const point of points) {
    const value = point[key]
    if (value == null) {
      drawing = false
      continue
    }
    const x = chart.left + (point.windowStart - from) / span * plotWidth
    const y = chart.top + (1 - Math.max(0, Math.min(1, value))) * plotHeight
    path += `${drawing ? ' L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`
    drawing = true
  }
  return path
}

const hEPath = computed(() => pathFor('hE'))
const hMPath = computed(() => pathFor('hM'))
const chartFrom = computed(() => data.value?.heat[0]?.windowStart ?? null)
const chartTo = computed(() => data.value?.heat.at(-1)?.windowStart ?? null)

const columns = [
  { accessorKey: 'windowStart', header: 'Window' },
  { accessorKey: 'rank', header: 'Rank' },
  { accessorKey: 'mentions', header: 'Mentions' },
  { accessorKey: 'authors', header: 'Authors' },
  { accessorKey: 'sov', header: 'SoV' },
  { accessorKey: 'hE', header: 'H_e' },
  { accessorKey: 'hM', header: 'H_m' },
  { accessorKey: 'divergence', header: 'Gap' },
  { accessorKey: 'quadrant', header: 'Quadrant' },
  { accessorKey: 'rankDelta', header: 'Δ Rank' },
  { accessorKey: 'ret', header: 'Ret' },
  { accessorKey: 'rvol', header: 'RVol' },
]
</script>

<template>
  <main class="page-shell space-y-7">
    <NuxtLink to="/board" class="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
      ← Heat board
    </NuxtLink>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      title="Failed to load heat history"
      :description="error.message"
    />

    <template v-if="data">
      <section class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p class="text-xs font-bold uppercase tracking-[0.18em] text-primary">Ticker heat history</p>
          <h1 class="mt-2 font-mono text-3xl font-black tracking-tight text-highlighted sm:text-4xl">
            {{ data.ticker.symbol }}
          </h1>
          <p v-if="data.ticker.name" class="mt-1 text-muted">{{ data.ticker.name }}</p>
        </div>
        <NuxtLink :to="`/?ticker=${data.ticker.symbol}`" class="text-sm font-semibold text-primary hover:underline">
          View published plays →
        </NuxtLink>
      </section>

      <UAlert
        v-if="!data.ticker.known"
        color="warning"
        variant="subtle"
        title="Unknown ticker"
        description="No ticker-name record or finalized heat observation exists for this symbol."
      />

      <section v-if="latest" class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div class="surface-panel rounded-2xl p-4">
          <p class="text-[10px] font-bold uppercase tracking-wide text-muted">Latest WSB heat</p>
          <p class="mt-1 text-2xl font-black tabular-nums text-highlighted">{{ fmt2(latest.hE) }}</p>
        </div>
        <div class="surface-panel rounded-2xl p-4">
          <p class="text-[10px] font-bold uppercase tracking-wide text-muted">Rank</p>
          <p class="mt-1 text-2xl font-black tabular-nums text-highlighted">#{{ latest.rank ?? '—' }}</p>
        </div>
        <div class="surface-panel rounded-2xl p-4">
          <p class="text-[10px] font-bold uppercase tracking-wide text-muted">Market heat</p>
          <p class="mt-1 text-2xl font-black tabular-nums text-highlighted">{{ fmt2(latest.hM) }}</p>
        </div>
        <div class="surface-panel rounded-2xl p-4">
          <p class="text-[10px] font-bold uppercase tracking-wide text-muted">Last observed</p>
          <p class="mt-1 text-sm font-bold text-highlighted">{{ fmtUtc(latest.windowStart) }} UTC</p>
        </div>
      </section>

      <section v-if="observed.length" class="surface-panel rounded-2xl p-4 sm:p-6">
        <div class="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 class="text-lg font-black text-highlighted">Finalized 7-day trajectory</h2>
            <p class="text-xs text-muted">Gaps are windows where this ticker had no empirical row or market overlay.</p>
          </div>
          <div class="flex gap-4 text-xs font-semibold">
            <span class="text-primary">— WSB Heat</span>
            <span class="text-warning">— Market Heat</span>
          </div>
        </div>
        <svg :viewBox="`0 0 ${chart.width} ${chart.height}`" class="h-auto w-full" role="img" :aria-label="`${ticker} WSB and market heat history`">
          <g class="text-muted" stroke="currentColor" stroke-opacity="0.2">
            <line v-for="level in [0, 0.25, 0.5, 0.75, 1]" :key="level" :x1="chart.left" :x2="chart.width - chart.right" :y1="chart.top + (1 - level) * plotHeight" :y2="chart.top + (1 - level) * plotHeight" />
          </g>
          <g fill="currentColor" class="text-muted text-[10px]">
            <text v-for="level in [0, 0.25, 0.5, 0.75, 1]" :key="level" x="4" :y="chart.top + (1 - level) * plotHeight + 3">{{ level.toFixed(2) }}</text>
            <text v-if="chartFrom" :x="chart.left" :y="chart.height - 6">{{ fmtUtc(chartFrom, false) }}</text>
            <text v-if="chartTo" :x="chart.width - chart.right" :y="chart.height - 6" text-anchor="end">{{ fmtUtc(chartTo, false) }}</text>
          </g>
          <path :d="hEPath" fill="none" stroke="var(--ui-primary)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" />
          <path :d="hMPath" fill="none" stroke="var(--ui-warning)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        </svg>
      </section>

      <section v-if="history.length" class="surface-panel overflow-x-auto rounded-2xl">
        <UTable :data="history" :columns="columns">
          <template #windowStart-cell="{ row }">{{ fmtUtc((row.original as HeatPoint).windowStart) }}</template>
          <template #rank-cell="{ row }">{{ (row.original as HeatPoint).rank ?? '—' }}</template>
          <template #mentions-cell="{ row }">{{ fmtInt((row.original as HeatPoint).mentions) }}</template>
          <template #authors-cell="{ row }">{{ fmtInt((row.original as HeatPoint).authors) }}</template>
          <template #sov-cell="{ row }">{{ fmtSov((row.original as HeatPoint).sov) }}</template>
          <template #hE-cell="{ row }">{{ fmt2((row.original as HeatPoint).hE) }}</template>
          <template #hM-cell="{ row }">{{ fmt2((row.original as HeatPoint).hM) }}</template>
          <template #divergence-cell="{ row }">{{ fmt2((row.original as HeatPoint).divergence) }}</template>
          <template #quadrant-cell="{ row }"><QuadrantBadge :quadrant="(row.original as HeatPoint).quadrant" /></template>
          <template #rankDelta-cell="{ row }">{{ fmtRankDelta((row.original as HeatPoint).rankDelta) }}</template>
          <template #ret-cell="{ row }">{{ fmtRet((row.original as HeatPoint).ret) }}</template>
          <template #rvol-cell="{ row }">{{ fmtRvol((row.original as HeatPoint).rvol) }}</template>
        </UTable>
      </section>

      <UAlert
        v-else-if="!error"
        color="info"
        variant="subtle"
        title="No finalized history"
        description="This ticker has no finalized heat observations in the last seven days."
      />
    </template>
  </main>
</template>
