<script setup lang="ts">
import { fmtUtc, fmtAgo } from '~/composables/useFormat'
import { useNow } from '~/composables/useNow'

const { data, error, refresh, status } = await useFetch('/api/board', { timeout: 10_000 })

// Client-side now (0 during SSR, then ticking) for relative timestamps — avoids hydration mismatch and
// keeps "ago" / staleness honest on a long-open page.
const nowSeconds = useNow()
useAutoRefresh(data, refresh, 60_000, () => status.value !== 'pending')

const windowProgress = computed(() => {
  const w = data.value?.window
  if (!w || !nowSeconds.value || nowSeconds.value < w.start || nowSeconds.value >= w.end) return ''
  const pct = Math.max(0, Math.min(100, Math.floor(100 * (nowSeconds.value - w.start) / (w.end - w.start))))
  return ` · in progress ${pct}%`
})

const windowHeader = computed(() => {
  const w = data.value?.window
  if (!w) return null

  const startStr = fmtUtc(w.start)
  const endStr = fmtUtc(w.end, false)
  const nTickers = data.value?.rows.length ?? 0
  const total = w.totalMentions != null ? ` · ${w.totalMentions} mentions` : ''
  const genStr = w.generatedAt != null ? ` · generated ${fmtUtc(w.generatedAt, false)} UTC` : ''
  const versionStr = w.scoringVersion ? ` · ${w.scoringVersion}` : ''
  const marketStr = w.marketAsOf != null ? ` · market as of ${fmtUtc(w.marketAsOf, false)} UTC` : ''

  return `Window: ${startStr}–${endStr} UTC · ${nTickers} tickers${total}${genStr}${marketStr}${versionStr}${windowProgress.value}`
})

const generatedAgo = computed(() => {
  if (!nowSeconds.value || !data.value?.window?.generatedAt) return ''
  return fmtAgo(data.value.window.generatedAt, nowSeconds.value)
})
</script>

<template>
  <main class="page-shell space-y-7">
    <section class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p class="text-xs font-bold uppercase tracking-[0.18em] text-primary mb-2">
          Attention radar
        </p>
        <h1 class="text-3xl sm:text-4xl font-black tracking-[-0.045em] text-highlighted">
          WSB Heat Board
        </h1>
        <p class="mt-2 max-w-2xl text-sm sm:text-base text-muted">
          The crowd tape, market overlay, and the distance between them.
        </p>
      </div>
      <div v-if="data?.state === 'ok'" class="flex items-center gap-2 text-sm text-muted">
        <span class="size-2 rounded-full bg-success" />
        <span>Latest published snapshot</span>
        <UButton
          icon="i-lucide-refresh-cw"
          color="neutral"
          variant="ghost"
          size="xs"
          :loading="status === 'pending'"
          aria-label="Refresh heat board"
          @click="refresh()"
        />
      </div>
    </section>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      title="Failed to load board"
      :description="error.message ?? 'The server returned an error. Try refreshing.'"
    />

    <template v-if="data">
      <section v-if="windowHeader" class="surface-panel rounded-2xl p-4 sm:p-5">
        <p class="text-[11px] font-bold uppercase tracking-[0.15em] text-primary mb-1.5">
          Current window
        </p>
        <p class="text-sm sm:text-base font-semibold text-highlighted">
          {{ windowHeader }}
        </p>
        <p v-if="generatedAgo" class="mt-1 text-xs text-muted">
          Published {{ generatedAgo }}
        </p>
      </section>

      <StatusBanners
        :state="data.state"
        :window="data.window"
        :source="data.source"
        :thresholds="data.thresholds"
      />

      <section v-if="data.state === 'ok'" class="space-y-8">
        <div>
          <div class="flex items-end justify-between gap-4 mb-3">
            <div>
              <h2 class="text-lg font-black text-highlighted">Ticker heat</h2>
              <p class="text-xs text-muted">Ranked by WSB Heat, share-of-voice primary.</p>
            </div>
            <span class="hidden sm:block text-xs text-muted">{{ data.rows.length }} tickers</span>
          </div>
          <BoardTable :rows="data.rows" />
        </div>
        <MoversTable :movers="data.movers" />
      </section>

      <MethodologyCard />
    </template>
  </main>
</template>
