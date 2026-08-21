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
  { label: 'any', value: 'any' },
  { label: 'gain', value: 'gain' },
  { label: 'loss', value: 'loss' },
]
const minConfItems = [
  { label: 'any', value: 'any' },
  { label: '≥ 0.6', value: '0.6' },
  { label: '≥ 0.8', value: '0.8' },
]
const sortItems = [
  { label: 'newest', value: 'newest' },
  { label: 'biggest P&L', value: 'pnl' },
]
const dateItems = [
  { label: 'all time', value: 'all' },
  { label: '24h', value: '1' },
  { label: '7d', value: '7' },
  { label: '30d', value: '30' },
]

/** Select items cannot use an empty value, so each cleared/default option gets a non-empty UI
 *  sentinel while the URL remains canonical (the corresponding query param is removed). */
function withClearSentinel(param: ReturnType<typeof useQueryParam>, sentinel: string) {
  return computed({
    get: () => param.value || sentinel,
    set: (value: string) => { param.value = value === sentinel ? '' : value },
  })
}

const categoryModel = withClearSentinel(category, 'any')
const signModel = withClearSentinel(sign, 'any')
const minConfModel = withClearSentinel(minConf, 'any')
const sortModel = withClearSentinel(sort, 'newest')

const reveal = computed({
  get: () => all.value === '1',
  set: (value: boolean) => { all.value = value ? '1' : '' },
})

/** date preset writes both `since` (unix seconds, what the API takes) and `days` (what the select
 *  displays) so the control's value survives a URL round-trip without re-deriving from `since`. */
const dateModel = computed({
  get: () => days.value || 'all',
  set: (value: string) => {
    const selectedDays = value === 'all' ? '' : value
    const { days: _d, since: _s, ...rest } = route.query
    router.replace({
      query: selectedDays
        ? { ...rest, days: selectedDays, since: String(Math.floor(Date.now() / 1000) - Number(selectedDays) * 86400) }
        : rest,
    })
  },
})

const anyFilterActive = computed(() =>
  !!(category.value || ticker.value || tag.value || sign.value || minConf.value || days.value || all.value),
)

const filtersOpen = ref(false)
const activeFilterCount = computed(() =>
  [category.value, ticker.value, tag.value, sign.value, minConf.value, days.value, all.value].filter(Boolean).length,
)


function resetFilters() {
  const {
    category: _category,
    ticker: _ticker,
    tag: _tag,
    sign: _sign,
    minConf: _minConf,
    sort: _sort,
    days: _days,
    since: _since,
    all: _all,
    ...next
  } = route.query
  router.replace({ query: next })
}

const query = computed(() => route.query)
const { data, error } = await useFetch('/api/plays', { query })

const nowSeconds = useNow()
</script>

<template>
  <main class="page-shell space-y-7">
    <section class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p class="text-xs font-bold uppercase tracking-[0.18em] text-primary mb-2">
          The live tape
        </p>
        <h1 class="text-3xl sm:text-4xl font-black tracking-[-0.045em] text-highlighted">
          WSB Plays
        </h1>
        <p class="mt-2 max-w-2xl text-sm sm:text-base text-muted">
          Broker screenshots, extracted positions, and the story behind the gamble.
        </p>
      </div>
      <div v-if="data" class="flex items-center gap-2 text-sm text-muted">
        <span class="size-2 rounded-full bg-success shadow-[0_0_0_4px_color-mix(in_srgb,var(--ui-success)_14%,transparent)]" />
        <span><strong class="text-highlighted tabular-nums">{{ data.plays.length }}</strong> plays on this tape</span>
      </div>
    </section>

    <!-- Every control writes straight to the URL query; the API remains the filtering authority. -->
    <section class="surface-panel rounded-2xl p-3 sm:p-4" aria-label="Play filters">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <UButton
            class="sm:hidden"
            color="neutral"
            variant="soft"
            icon="i-lucide-sliders-horizontal"
            :label="activeFilterCount ? `Filters · ${activeFilterCount}` : 'Filters'"
            @click="filtersOpen = !filtersOpen"
          />
          <span class="hidden sm:block text-xs font-bold uppercase tracking-[0.14em] text-muted">Filters</span>
          <UBadge v-if="activeFilterCount" color="primary" variant="subtle" size="sm">
            {{ activeFilterCount }} active
          </UBadge>
        </div>
        <UButton
          v-if="anyFilterActive"
          color="neutral"
          variant="ghost"
          size="sm"
          icon="i-lucide-rotate-ccw"
          label="Reset"
          @click="resetFilters"
        />
      </div>

      <div
        class="mt-4 grid-cols-2 gap-3 sm:grid sm:grid-cols-4 xl:grid-cols-12"
        :class="filtersOpen ? 'grid' : 'hidden'"
      >
        <label class="col-span-2 sm:col-span-2 xl:col-span-3 space-y-1.5">
          <span class="block text-[11px] font-bold uppercase tracking-wider text-muted">Category</span>
          <USelect v-model="categoryModel" :items="categoryItems" class="w-full" size="lg" />
        </label>
        <label class="col-span-1 xl:col-span-2 space-y-1.5">
          <span class="block text-[11px] font-bold uppercase tracking-wider text-muted">Ticker</span>
          <UInput v-model="ticker" placeholder="NVDA" class="w-full" size="lg" />
        </label>
        <label class="col-span-1 xl:col-span-2 space-y-1.5">
          <span class="block text-[11px] font-bold uppercase tracking-wider text-muted">Tag</span>
          <UInput v-model="tag" placeholder="0dte" class="w-full" size="lg" />
        </label>
        <label class="col-span-1 xl:col-span-1 space-y-1.5">
          <span class="block text-[11px] font-bold uppercase tracking-wider text-muted">Result</span>
          <USelect v-model="signModel" :items="signItems" class="w-full" size="lg" />
        </label>
        <label class="col-span-1 xl:col-span-1 space-y-1.5">
          <span class="block text-[11px] font-bold uppercase tracking-wider text-muted">Confidence</span>
          <USelect v-model="minConfModel" :items="minConfItems" class="w-full" size="lg" />
        </label>
        <label class="col-span-1 xl:col-span-1 space-y-1.5">
          <span class="block text-[11px] font-bold uppercase tracking-wider text-muted">Date</span>
          <USelect v-model="dateModel" :items="dateItems" class="w-full" size="lg" />
        </label>
        <label class="col-span-1 xl:col-span-2 space-y-1.5">
          <span class="block text-[11px] font-bold uppercase tracking-wider text-muted">Sort</span>
          <USelect v-model="sortModel" :items="sortItems" class="w-full" size="lg" />
        </label>
      </div>

      <div class="mt-4 flex items-center justify-between gap-4 border-t border-default pt-3">
        <label for="reveal-low-confidence" class="flex items-center gap-2.5 cursor-pointer">
          <USwitch id="reveal-low-confidence" v-model="reveal" />
          <span class="text-xs sm:text-sm text-toned">Show low-confidence &amp; unclassifiable</span>
        </label>
        <span class="hidden md:block text-xs text-muted">Hidden by default to keep the tape useful.</span>
      </div>
    </section>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      title="Failed to load plays"
      :description="error.message ?? 'The server returned an error. Try refreshing.'"
    />

    <template v-if="data">
      <div v-if="data.plays.length === 0" class="surface-panel rounded-2xl px-6 py-14 text-center">
        <UIcon name="i-lucide-search-x" class="size-8 text-muted mx-auto mb-3" />
        <p class="font-semibold text-highlighted">
          {{ anyFilterActive ? 'No plays match these filters.' : 'No plays captured yet.' }}
        </p>
        <p class="mt-1 text-sm text-muted">
          {{ anyFilterActive ? 'Reset the tape or try a broader query.' : 'The worker enqueues flair-matched posts each poll cycle.' }}
        </p>
      </div>

      <ul v-else class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
        <li
          v-for="play in data.plays"
          :key="play.id"
          class="group surface-panel rounded-2xl overflow-hidden flex flex-col transition duration-200 hover:-translate-y-0.5 hover:border-accented hover:shadow-lg"
        >
          <NuxtLink :to="`/plays/${play.id}`" class="flex flex-col flex-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
            <div v-if="play.thumb" class="relative aspect-[16/10] overflow-hidden bg-[#0b1117]">
              <img
                :src="`/api/media/${play.thumb}`"
                alt=""
                aria-hidden="true"
                class="absolute inset-[-8%] size-[116%] object-cover opacity-35 blur-xl scale-110"
                loading="lazy"
              >
              <img
                :src="`/api/media/${play.thumb}`"
                :alt="play.title ?? play.id"
                class="relative z-10 size-full object-contain p-2 drop-shadow-2xl transition-transform duration-300 group-hover:scale-[1.015]"
                loading="lazy"
              >
              <div class="absolute inset-x-0 top-0 z-20 flex items-center justify-between p-3 pointer-events-none">
                <span v-if="nowSeconds && play.createdUtc" class="rounded-full bg-black/65 px-2 py-1 text-[11px] font-medium text-white backdrop-blur">
                  {{ fmtAgo(play.createdUtc, nowSeconds) }}
                </span>
                <span v-if="play.imageCount > 1" class="ml-auto rounded-full bg-black/65 px-2 py-1 text-[11px] font-medium text-white backdrop-blur">
                  {{ play.imageCount }} images
                </span>
              </div>
            </div>
            <div v-else class="aspect-[16/10] bg-inverted flex flex-col items-center justify-center gap-2 text-inverted">
              <UIcon name="i-lucide-file-text" class="size-7 opacity-60" />
              <span class="text-sm font-medium">{{ play.mediaStatus === 'pending' ? 'Media pending' : 'Text-only play' }}</span>
            </div>

            <div class="p-4 sm:p-5 space-y-3 flex-1">
              <div v-if="play.primaryTicker || play.pnlAbs != null || play.pnlPct != null" class="flex items-start justify-between gap-4">
                <div>
                  <p v-if="play.primaryTicker" class="font-mono text-xl font-black tracking-tight text-highlighted">
                    {{ play.primaryTicker }}
                  </p>
                  <span v-if="play.realized === false" class="text-[11px] font-semibold uppercase tracking-wider text-muted">Open position</span>
                </div>
                <div class="text-right">
                  <p v-if="play.pnlAbs != null" class="text-xl font-black leading-none tabular-nums" :class="pnlClass(play.pnlAbs)">
                    {{ fmtSignedUsd(play.pnlAbs) }}
                  </p>
                  <p v-if="play.pnlPct != null" class="mt-1 text-sm font-semibold tabular-nums" :class="pnlClass(play.pnlPct)">
                    {{ fmtPctPoints(play.pnlPct) }}
                  </p>
                </div>
              </div>

              <div class="flex items-center gap-1.5 flex-wrap">
                <UBadge :color="flairColor(play.flair)" variant="subtle" size="sm">
                  {{ play.flair ?? '—' }}
                </UBadge>
                <UBadge v-if="play.category" :color="categoryColor(play.category)" variant="subtle" size="sm">
                  {{ play.category }}
                </UBadge>
                <UBadge v-else color="neutral" variant="subtle" size="sm">
                  {{ play.status }}
                </UBadge>
                <UBadge v-if="play.confidence != null" color="neutral" variant="outline" size="sm">
                  {{ (play.confidence * 100).toFixed(0) }}% confidence
                </UBadge>
              </div>

              <h2 class="text-base font-bold leading-snug text-highlighted line-clamp-2">
                {{ play.title ?? '(untitled)' }}
              </h2>
              <p v-if="play.tldr" class="text-sm leading-relaxed text-muted line-clamp-3">
                {{ play.tldr }}
              </p>
            </div>
          </NuxtLink>

          <div class="flex items-center justify-between gap-3 border-t border-default px-4 sm:px-5 py-3 text-xs text-muted">
            <span class="truncate">u/{{ play.author ?? '[deleted]' }}</span>
            <a
              v-if="play.permalink"
              :href="`https://www.reddit.com${play.permalink}`"
              target="_blank"
              rel="noopener noreferrer"
              class="shrink-0 font-semibold hover:text-primary"
            >Reddit ↗</a>
          </div>
        </li>
      </ul>
    </template>
  </main>
</template>
