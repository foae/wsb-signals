<script setup lang="ts">
import type { BoardResponse, BoardWindow } from '~/types/board'
import { fmtAgo } from '~/composables/useFormat'
import { useNow } from '~/composables/useNow'

const props = defineProps<{
  state: 'ok' | 'empty' | 'no-data'
  window: BoardWindow | null
  source: BoardResponse['source']
  thresholds: { windowSeconds: number; maxStalenessSeconds: number }
}>()

const nowSeconds = useNow()

const isStale = computed(() => {
  if (!nowSeconds.value || props.window?.newestUtc == null) return false
  return (nowSeconds.value - props.window.newestUtc) > props.thresholds.maxStalenessSeconds
})

const staleAgo = computed(() => {
  if (!props.window?.newestUtc || !nowSeconds.value) return ''
  return fmtAgo(props.window.newestUtc, nowSeconds.value)
})

const sourceProblem = computed(() => {
  const bad = (['posts', 'comments'] as const).flatMap((kind) => {
    const run = props.source[kind]
    if (!run) return [`${kind}: no status`]
    if (nowSeconds.value && nowSeconds.value - run.pollTs > props.thresholds.maxStalenessSeconds) {
      return [`${kind}: last status ${fmtAgo(run.pollTs, nowSeconds.value)} old`]
    }
    return !['fresh', 'capped'].includes(run.status) ? [`${kind}: ${run.status}`] : []
  })
  return bad.length
    ? `Source coverage degraded — ${bad.join(' · ')}. The worker will not score a new board until both kinds are usable (fresh or capped).`
    : ''
})

const marketProblem = computed(() => {
  const w = props.window
  if (!w || !w.marketStatus || w.marketStatus === 'fresh') return ''
  if (w.marketStatus === 'disabled') return 'Market overlay disabled — this snapshot is empirical-only.'
  const coverage = w.marketRequested != null && w.marketUsable != null
    ? ` (${w.marketUsable}/${w.marketRequested} usable)`
    : ''
  const age = w.marketAsOf != null && nowSeconds.value ? `; oldest evidence ${fmtAgo(w.marketAsOf, nowSeconds.value)}` : ''
  if (w.marketStatus === 'partial') return `Market overlay partial${coverage}${age}. Missing rows have no divergence or quadrant.`
  if (w.marketStatus === 'preserved') return `Market overlay fetch failed; prior same-window data was preserved${coverage}${age}.`
  return `Market overlay unavailable${coverage}. Divergence and quadrants are withheld.`
})
</script>

<template>
  <div class="flex flex-col gap-3">
    <UAlert
      v-if="sourceProblem"
      color="error"
      variant="subtle"
      title="Source coverage degraded"
      :description="sourceProblem"
    />

    <UAlert
      v-if="marketProblem"
      :color="props.window?.marketStatus === 'disabled' ? 'info' : 'warning'"
      variant="subtle"
      title="Market overlay degraded"
      :description="marketProblem"
    />
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
