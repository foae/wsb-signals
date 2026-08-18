<script setup lang="ts">
import { fmtAgo } from '~/composables/useFormat'
import { useNow } from '~/composables/useNow'

// Bare P1 list (plays-plan §3): captured plays with thumbnails, proving capture → media volume → web
// end-to-end before any LLM money is spent. P4 replaces this with the real board (filters, detail pages).
const { data, error } = await useFetch('/api/plays')

const nowSeconds = useNow()

const flairColor = (flair: string | null): 'success' | 'error' | 'warning' | 'neutral' => {
  if (flair === 'Gain') return 'success'
  if (flair === 'Loss') return 'error'
  if (flair === 'YOLO') return 'warning'
  return 'neutral'
}
</script>

<template>
  <main class="max-w-screen-2xl mx-auto px-4 py-8 space-y-6">
    <div class="flex items-baseline gap-3">
      <h1 class="text-2xl font-bold">
        WSB Plays
      </h1>
      <span class="text-sm text-muted">captured gain/loss/YOLO posts — observational research, NOT a trading signal</span>
    </div>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      title="Failed to load plays"
      :description="error.message ?? 'The server returned an error. Try refreshing.'"
    />

    <template v-if="data">
      <p v-if="data.plays.length === 0" class="text-sm text-muted">
        No plays captured yet — the worker enqueues flair-matched posts each poll cycle.
      </p>

      <ul class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <li
          v-for="play in data.plays"
          :key="play.id"
          class="rounded-lg border border-default overflow-hidden flex flex-col"
        >
          <img
            v-if="play.thumb"
            :src="`/api/media/${play.thumb}`"
            :alt="play.title ?? play.id"
            class="w-full h-48 object-cover object-top bg-elevated"
            loading="lazy"
          >
          <div v-else class="w-full h-48 bg-elevated flex items-center justify-center text-sm text-muted">
            {{ play.mediaStatus === 'pending' ? 'media pending' : 'text-only' }}
          </div>
          <div class="p-3 space-y-2 flex-1">
            <div class="flex items-center gap-2 text-xs">
              <UBadge :color="flairColor(play.flair)" variant="subtle">
                {{ play.flair ?? '—' }}
              </UBadge>
              <span class="text-muted">{{ play.status }}</span>
              <span v-if="play.imageCount > 1" class="text-muted">{{ play.imageCount }} images</span>
              <span v-if="nowSeconds && play.createdUtc" class="text-muted ml-auto">
                {{ fmtAgo(play.createdUtc, nowSeconds) }}
              </span>
            </div>
            <p class="text-sm font-medium line-clamp-2">
              {{ play.title ?? '(untitled)' }}
            </p>
            <p class="text-xs text-muted">
              u/{{ play.author ?? '[deleted]' }}
              <a
                v-if="play.permalink"
                :href="`https://www.reddit.com${play.permalink}`"
                target="_blank"
                rel="noopener noreferrer"
                class="underline hover:text-highlighted"
              >reddit ↗</a>
            </p>
          </div>
        </li>
      </ul>
    </template>
  </main>
</template>
