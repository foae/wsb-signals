<script setup lang="ts">
import { fmtAgo, fmtSignedUsd, fmtPctPoints } from '~/composables/useFormat'
import { useNow } from '~/composables/useNow'
import { flairColor, categoryColor, pnlClass, CATEGORIES } from '~/utils/play-ui'

// Card grid over the published board fields (P3 denormalization); pipeline-in-progress plays show
// their queue status instead. Cards link to /plays/:id. Filter/sort bar (P4) writes straight to the
// URL query so it's the single source of truth — the board's ticker cross-link (/?ticker=NVDA)
// lands pre-filtered, and the filtered view is shareable/bookmarkable.
const route = useRoute()
const router = useRouter()

/** One param, one field: read from route.query, write via router.replace (add when truthy, else
 *  delete). Keeps the URL canonical instead of duplicating state in refs. */
function useQueryParam(key: string) {
  return computed({
    get: () => (typeof route.query[key] === 'string' ? (route.query[key] as string) : ''),
    set: (value: string) => {
      const { [key]: _omit, ...rest } = route.query
      router.replace({ query: value ? { ...rest, [key]: value } : rest })
    },
  })
}

const category = useQueryParam('category')
const ticker = useQueryParam('ticker')
const tag = useQueryParam('tag')
const sign = useQueryParam('sign')
const minConf = useQueryParam('minConf')
const sort = useQueryParam('sort')
const days = useQueryParam('days')
const all = useQueryParam('all')

const categoryItems = ['any', ...CATEGORIES]
const signItems = [
  { label: 'any', value: '' },
  { label: 'gain', value: 'gain' },
  { label: 'loss', value: 'loss' },
]
const minConfItems = [
  { label: 'any', value: '' },
  { label: '≥ 0.6', value: '0.6' },
  { label: '≥ 0.8', value: '0.8' },
]
const sortItems = [
  { label: 'newest', value: '' },
  { label: 'biggest P&L', value: 'pnl' },
]
const dateItems = [
  { label: 'all time', value: '' },
  { label: '24h', value: '1' },
  { label: '7d', value: '7' },
  { label: '30d', value: '30' },
]

/** category select uses 'any' as the cleared sentinel (USelect needs a non-empty value to display
 *  a placeholder-like "any" option); everything else clears on empty string. */
const categoryModel = computed({
  get: () => category.value || 'any',
  set: (value: string) => { category.value = value === 'any' ? '' : value },
})

const reveal = computed({
  get: () => all.value === '1',
  set: (value: boolean) => { all.value = value ? '1' : '' },
})

/** date preset writes both `since` (unix seconds, what the API takes) and `days` (what the select
 *  displays) so the control's value survives a URL round-trip without re-deriving from `since`. */
const dateModel = computed({
  get: () => days.value,
  set: (value: string) => {
    const { days: _d, since: _s, ...rest } = route.query
    router.replace({
      query: value
        ? { ...rest, days: value, since: String(Math.floor(Date.now() / 1000) - Number(value) * 86400) }
        : rest,
    })
  },
})

const anyFilterActive = computed(() =>
  !!(category.value || ticker.value || tag.value || sign.value || minConf.value || days.value || all.value),
)

const query = computed(() => route.query)
const { data, error } = await useFetch('/api/plays', { query })

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

    <!-- Filter / sort bar — every control writes straight to the URL query -->
    <div class="flex flex-wrap items-end gap-3">
      <USelect v-model="categoryModel" :items="categoryItems" class="w-44" />
      <UInput v-model="ticker" placeholder="ticker" class="w-28" />
      <UInput v-model="tag" placeholder="tag" class="w-32" />
      <USelect v-model="sign" :items="signItems" class="w-28" />
      <USelect v-model="minConf" :items="minConfItems" class="w-32" />
      <USelect v-model="dateModel" :items="dateItems" class="w-32" />
      <USelect v-model="sort" :items="sortItems" class="w-40" />
      <div class="flex items-center gap-2">
        <USwitch v-model="reveal" />
        <span class="text-xs text-muted">show low-confidence &amp; unclassifiable</span>
      </div>
    </div>
    <p class="text-xs text-muted -mt-4">
      The default view hides low-confidence and unclassifiable plays.
    </p>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      title="Failed to load plays"
      :description="error.message ?? 'The server returned an error. Try refreshing.'"
    />

    <template v-if="data">
      <p v-if="data.plays.length === 0 && !anyFilterActive" class="text-sm text-muted">
        No plays captured yet — the worker enqueues flair-matched posts each poll cycle.
      </p>
      <p v-else-if="data.plays.length === 0" class="text-sm text-muted">
        No plays match these filters.
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
