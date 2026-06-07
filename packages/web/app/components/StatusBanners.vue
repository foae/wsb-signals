<script setup lang="ts">
import type { BoardWindow } from '~/types/board'
import { fmtAgo } from '~/composables/useFormat'
import { useNow } from '~/composables/useNow'

const props = defineProps<{
  state: 'ok' | 'empty' | 'no-data'
  window: BoardWindow | null
  thresholds: { windowSeconds: number; maxStalenessSeconds: number }
}>()

// Client-side now (0 during SSR, then ticking) — avoids hydration mismatch AND keeps the stale check
// live so a long-open page flips to "stale" correctly instead of freezing the mount-time clock.
const nowSeconds = useNow()

const isStale = computed(() => {
  if (!nowSeconds.value) return false
  if (props.window?.newestUtc == null) return false
  return (nowSeconds.value - props.window.newestUtc) > props.thresholds.maxStalenessSeconds
})

const staleAgo = computed(() => {
  if (!props.window?.newestUtc || !nowSeconds.value) return ''
  return fmtAgo(props.window.newestUtc, nowSeconds.value)
})
</script>

<template>
  <div class="flex flex-col gap-3">
    <UAlert
      v-if="props.state === 'no-data'"
      color="info"
      variant="subtle"
      title="No data yet"
      description="No complete window yet — the worker hasn't published a cycle. Check back shortly."
    />

    <UAlert
      v-if="props.state === 'empty'"
      color="warning"
      variant="subtle"
      title="Empty window"
      description="Quiet window — no tickers in the latest cycle."
    />

    <UAlert
      v-if="props.state === 'ok' && props.window?.quiet"
      color="warning"
      variant="subtle"
      title="Quiet window"
      :description="`Quiet window — only ${props.window.totalMentions} total mentions. Rankings are low-confidence (thin-support rows are damped, but small-sample noise dominates off-hours).`"
    />

    <UAlert
      v-if="props.state === 'ok' && props.window?.capped"
      color="error"
      variant="subtle"
      title="Incomplete window"
      description="Incomplete window — the source poll hit its pagination cap, so this window is undercounted; sov is unreliable (data-model invariant 14). Raise ingest.max_pages if this recurs at peak hours."
    />

    <UAlert
      v-if="isStale"
      color="warning"
      variant="subtle"
      title="Stale data"
      :description="`Stale data — newest source item is ${staleAgo} old (Arctic-Shift is the sole live tap).`"
    />
  </div>
</template>
