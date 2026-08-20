<script setup lang="ts">
import { fmtUtc, fmtAgo } from '~/composables/useFormat'
import { useNow } from '~/composables/useNow'

const { data, error } = await useFetch('/api/board')

// Client-side now (0 during SSR, then ticking) for relative timestamps — avoids hydration mismatch and
// keeps "ago" / staleness honest on a long-open page.
const nowSeconds = useNow()

const windowHeader = computed(() => {
  const w = data.value?.window
  if (!w) return null

  const startStr = fmtUtc(w.start)
  const endStr = fmtUtc(w.end, false)
  const nTickers = data.value?.rows.length ?? 0
  const total = w.totalMentions != null ? ` · ${w.totalMentions} mentions` : ''
  const genStr = w.generatedAt != null ? ` · generated ${fmtUtc(w.generatedAt, false)} UTC` : ''

  return `Window: ${startStr}–${endStr} UTC · ${nTickers} tickers${total}${genStr}`
})

const generatedAgo = computed(() => {
  if (!nowSeconds.value || !data.value?.window?.generatedAt) return ''
  return fmtAgo(data.value.window.generatedAt, nowSeconds.value)
})
</script>

<template>
  <main class="max-w-screen-2xl mx-auto px-4 py-8 space-y-6">
    <div class="flex items-baseline gap-3">
      <h1 class="text-2xl font-bold">
        WSB Signals
      </h1>
      <span class="text-sm text-muted">trending radar</span>
    </div>

    <!-- Error state -->
    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      title="Failed to load board"
      :description="error.message ?? 'The server returned an error. Try refreshing.'"
    />

    <template v-if="data">
      <!-- Window header -->
      <div v-if="windowHeader" class="space-y-0.5">
        <p class="text-base font-medium">
          {{ windowHeader }}
        </p>
        <p v-if="generatedAgo" class="text-xs text-muted">
          {{ generatedAgo }}
        </p>
      </div>

      <!-- Status banners -->
      <StatusBanners
        :state="data.state"
        :window="data.window"
        :thresholds="data.thresholds"
      />

      <!-- Board -->
      <template v-if="data.state === 'ok'">
        <BoardTable :rows="data.rows" />
        <MoversTable :movers="data.movers" />
      </template>

      <!-- Methodology always shown -->
      <MethodologyCard />
    </template>
  </main>
</template>
