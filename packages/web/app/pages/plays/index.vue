<script setup lang="ts">
import { fmtAgo, fmtSignedUsd, fmtPctPoints } from '~/composables/useFormat'
import { useNow } from '~/composables/useNow'
import { flairColor, categoryColor, pnlClass } from '~/utils/play-ui'

// Card grid over the published board fields (P3 denormalization); pipeline-in-progress plays show
// their queue status instead. Cards link to /plays/:id. P4 proper adds filters/sorts on top.
const { data, error } = await useFetch('/api/plays')

const nowSeconds = useNow()
</script>

<template>
  <main class="max-w-screen-2xl mx-auto px-4 py-8 space-y-6">
    <div class="flex items-baseline gap-3">
      <h1 class="text-2xl font-bold">
        WSB Plays
      </h1>
      <span class="text-sm text-muted">captured gain/loss/YOLO posts</span>
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
          class="rounded-lg border border-default overflow-hidden flex flex-col hover:border-accented transition-colors"
        >
          <NuxtLink :to="`/plays/${play.id}`" class="flex flex-col flex-1">
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
              <div class="flex items-center gap-2 text-xs flex-wrap">
                <UBadge :color="flairColor(play.flair)" variant="subtle">
                  {{ play.flair ?? '—' }}
                </UBadge>
                <UBadge v-if="play.category" :color="categoryColor(play.category)" variant="subtle">
                  {{ play.category }}
                </UBadge>
                <span v-else class="text-muted">{{ play.status }}</span>
                <span v-if="nowSeconds && play.createdUtc" class="text-muted ml-auto">
                  {{ fmtAgo(play.createdUtc, nowSeconds) }}
                </span>
              </div>
              <div v-if="play.primaryTicker || play.pnlAbs != null || play.pnlPct != null" class="flex items-baseline gap-2 text-sm">
                <span v-if="play.primaryTicker" class="font-mono font-semibold">{{ play.primaryTicker }}</span>
                <span v-if="play.pnlAbs != null" class="font-semibold tabular-nums" :class="pnlClass(play.pnlAbs)">
                  {{ fmtSignedUsd(play.pnlAbs) }}
                </span>
                <span v-if="play.pnlPct != null" class="text-xs tabular-nums" :class="pnlClass(play.pnlPct)">
                  {{ fmtPctPoints(play.pnlPct) }}
                </span>
                <span v-if="play.realized === false" class="text-xs text-muted">open</span>
              </div>
              <p class="text-sm font-medium line-clamp-2">
                {{ play.title ?? '(untitled)' }}
              </p>
              <p v-if="play.tldr" class="text-xs text-muted line-clamp-2">
                {{ play.tldr }}
              </p>
              <p v-if="play.imageCount > 1" class="text-xs text-muted">
                {{ play.imageCount }} images
              </p>
            </div>
          </NuxtLink>
          <div class="px-3 pb-3 text-xs text-muted">
            u/{{ play.author ?? '[deleted]' }}
            <a
              v-if="play.permalink"
              :href="`https://www.reddit.com${play.permalink}`"
              target="_blank"
              rel="noopener noreferrer"
              class="underline hover:text-highlighted"
            >reddit ↗</a>
          </div>
        </li>
      </ul>
    </template>
  </main>
</template>
