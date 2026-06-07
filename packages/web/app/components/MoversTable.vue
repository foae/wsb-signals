<script setup lang="ts">
import type { Mover } from '~/types/board'
import { fmtAgo, fmtUtc } from '~/composables/useFormat'
import { useNow } from '~/composables/useNow'

const props = defineProps<{
  movers: Mover[]
}>()

const nowSeconds = useNow()

// The screener is captured INDEPENDENTLY of the WSB window (porting-spec §11) — surface its capture time
// so an hours-old screener (market source down) reads as old, not as current (review-gate finding).
const captureTs = computed(() => props.movers[0]?.ts ?? null)
const captureLabel = computed(() => {
  if (captureTs.value == null) return ''
  const ago = nowSeconds.value ? ` · ${fmtAgo(captureTs.value, nowSeconds.value)}` : ''
  return `Screener as of ${fmtUtc(captureTs.value)} UTC${ago}`
})

const numericClass = 'text-right tabular-nums'

const columns = [
  { accessorKey: 'symbol', header: 'Symbol', meta: { class: { th: '', td: 'font-mono font-semibold' } } },
  { accessorKey: 'name', header: 'Name', meta: { class: { th: '', td: 'text-sm max-w-48 truncate' } } },
  { accessorKey: 'kind', header: 'Kind', meta: { class: { th: '', td: 'text-sm' } } },
  { accessorKey: 'percentChange', header: '% Change', meta: { class: { th: numericClass, td: numericClass } } },
  { accessorKey: 'price', header: 'Price', meta: { class: { th: numericClass, td: numericClass } } },
  { accessorKey: 'volume', header: 'Volume', meta: { class: { th: numericClass, td: numericClass } } },
]

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—'
  const sign = v >= 0 ? '+' : ''
  return sign + v.toFixed(1) + '%'
}

function fmtPrice(v: number | null | undefined): string {
  if (v == null) return '—'
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtVolume(v: number | null | undefined): string {
  if (v == null) return '—'
  return Math.round(v).toLocaleString('en-US')
}
</script>

<template>
  <div v-if="props.movers.length > 0" class="mt-8">
    <div class="flex items-baseline gap-3 mb-1">
      <h2 class="text-base font-semibold">
        Market movers (free screener — STEALTH candidates)
      </h2>
      <span v-if="captureLabel" class="text-xs text-muted">{{ captureLabel }}</span>
    </div>
    <p class="text-xs text-muted mb-3">
      Market-wide screener snapshot (<code>kind</code>: <code>active</code> / <code>gainer</code> / <code>loser</code>).
      These are STEALTH candidates: names the market is moving that WSB may not have noticed yet.
      Captured independently of the WSB window; the timestamp above reflects screener poll time.
    </p>
    <div class="overflow-x-auto">
      <UTable :data="props.movers" :columns="columns">
        <template #symbol-cell="{ row }">
          {{ row.original.symbol ?? '—' }}
        </template>
        <template #percentChange-cell="{ row }">
          <span
            :class="{
              'text-green-600 dark:text-green-400': (row.original.percentChange ?? 0) > 0,
              'text-red-600 dark:text-red-400': (row.original.percentChange ?? 0) < 0,
            }"
          >
            {{ fmtPct(row.original.percentChange) }}
          </span>
        </template>
        <template #price-cell="{ row }">
          {{ fmtPrice(row.original.price) }}
        </template>
        <template #volume-cell="{ row }">
          {{ fmtVolume(row.original.volume) }}
        </template>
      </UTable>
    </div>
  </div>
</template>
