<script setup lang="ts">
import type { BoardRow } from '~/types/board'
import {
  fmtSov,
  fmtRet,
  fmtRvol,
  fmt2,
  fmtInt,
  fmtRankDelta,
} from '~/composables/useFormat'

const props = defineProps<{
  rows: BoardRow[]
}>()

const numericClass = 'text-right tabular-nums'
const diagnosticClass = 'hidden 2xl:table-cell'
const secondaryClass = 'hidden xl:table-cell'

const columns = [
  { accessorKey: 'rank', header: 'Rank', meta: { class: { th: numericClass, td: numericClass + ' text-muted' } } },
  { accessorKey: 'ticker', header: 'Ticker', meta: { class: { th: '', td: 'font-mono font-bold text-highlighted' } } },
  { accessorKey: 'name', header: 'Name', meta: { class: { th: 'hidden lg:table-cell', td: 'hidden lg:table-cell text-muted max-w-40 truncate' } } },
  { accessorKey: 'mentions', header: 'Mentions', meta: { class: { th: numericClass, td: numericClass } } },
  { accessorKey: 'authors', header: 'Authors', meta: { class: { th: numericClass, td: numericClass } } },
  { accessorKey: 'sov', header: 'SoV', meta: { class: { th: numericClass, td: numericClass + ' font-semibold' } } },
  { accessorKey: 'velocity', header: 'Velocity', meta: { class: { th: numericClass + ' ' + diagnosticClass, td: numericClass + ' ' + diagnosticClass } } },
  { accessorKey: 'accel', header: 'Accel', meta: { class: { th: numericClass + ' ' + diagnosticClass, td: numericClass + ' ' + diagnosticClass } } },
  { accessorKey: 'z', header: 'Z', meta: { class: { th: numericClass + ' ' + diagnosticClass, td: numericClass + ' ' + diagnosticClass } } },
  { accessorKey: 'netDir', header: 'Net Dir', meta: { class: { th: numericClass + ' ' + diagnosticClass, td: numericClass + ' ' + diagnosticClass } } },
  { accessorKey: 'ddCount', header: 'DD', meta: { class: { th: numericClass + ' ' + diagnosticClass, td: numericClass + ' ' + diagnosticClass } } },
  { accessorKey: 'baselineStatus', header: 'Baseline', meta: { class: { th: diagnosticClass, td: diagnosticClass } } },
  { accessorKey: 'hE', header: 'H_e', meta: { class: { th: numericClass, td: numericClass + ' font-black text-highlighted' } } },
  { accessorKey: 'divergence', header: 'Divergence', meta: { class: { th: numericClass, td: numericClass } } },
  { accessorKey: 'quadrant', header: 'Quadrant', meta: { class: { th: '', td: '' } } },
  { accessorKey: 'rankDelta', header: 'Δ Rank', meta: { class: { th: numericClass + ' ' + secondaryClass, td: numericClass + ' ' + secondaryClass } } },
  { accessorKey: 'ret', header: 'Ret', meta: { class: { th: numericClass, td: numericClass } } },
  { accessorKey: 'rvol', header: 'RVol', meta: { class: { th: numericClass, td: numericClass } } },
  { accessorKey: 'hM', header: 'H_m', meta: { class: { th: numericClass, td: numericClass + ' font-semibold' } } },
]
</script>

<template>
  <div class="space-y-3">
    <div class="sm:hidden space-y-3">
      <article
        v-for="row in props.rows"
        :key="row.ticker"
        class="surface-panel rounded-2xl p-4"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-baseline gap-2">
              <span class="text-xs tabular-nums text-muted">#{{ row.rank }}</span>
              <NuxtLink :to="`/board/${row.ticker}`" class="font-mono text-lg font-black text-highlighted hover:text-primary">
                {{ row.ticker }}
              </NuxtLink>
            </div>
            <p v-if="row.name" class="truncate text-xs text-muted">
              {{ row.name }}
            </p>
          </div>
          <QuadrantBadge :quadrant="row.quadrant" />
        </div>

        <div class="mt-4 grid grid-cols-3 gap-2">
          <div>
            <p class="text-[10px] font-bold uppercase tracking-wide text-muted">WSB heat</p>
            <p class="mt-0.5 text-xl font-black tabular-nums text-highlighted">{{ fmt2(row.hE) }}</p>
          </div>
          <div>
            <p class="text-[10px] font-bold uppercase tracking-wide text-muted">Market</p>
            <p class="mt-0.5 text-xl font-semibold tabular-nums">{{ fmt2(row.hM) }}</p>
          </div>
          <div>
            <p class="text-[10px] font-bold uppercase tracking-wide text-muted">Gap</p>
            <p class="mt-0.5 text-xl font-semibold tabular-nums">{{ fmt2(row.divergence) }}</p>
          </div>
        </div>

        <div class="mt-4 grid grid-cols-3 gap-x-3 gap-y-2 border-t border-default pt-3 text-xs">
          <p><span class="text-muted">Mentions</span><br><strong class="tabular-nums">{{ fmtInt(row.mentions) }}</strong></p>
          <p><span class="text-muted">Authors</span><br><strong class="tabular-nums">{{ fmtInt(row.authors) }}</strong></p>
          <p><span class="text-muted">SoV</span><br><strong class="tabular-nums">{{ fmtSov(row.sov) }}</strong></p>
          <p><span class="text-muted">Return</span><br><strong class="tabular-nums">{{ fmtRet(row.ret) }}</strong></p>
          <p><span class="text-muted">RVol</span><br><strong class="tabular-nums">{{ fmtRvol(row.rvol) }}</strong></p>
          <p><span class="text-muted">Rank move</span><br><strong class="tabular-nums">{{ fmtRankDelta(row.rankDelta) }}</strong></p>
        </div>

        <details class="mt-3 text-xs text-muted">
          <summary class="cursor-pointer font-semibold">Diagnostics</summary>
          <div class="mt-2 grid grid-cols-3 gap-2">
            <span>Velocity <strong class="text-toned">{{ fmt2(row.velocity) }}</strong></span>
            <span>Accel <strong class="text-toned">{{ fmt2(row.accel) }}</strong></span>
            <span>Z <strong class="text-toned">{{ fmt2(row.z) }}</strong></span>
            <span>Net dir <strong class="text-toned">{{ fmt2(row.netDir) }}</strong></span>
            <span>DD <strong class="text-toned">{{ fmtInt(row.ddCount) }}</strong></span>
            <span>Baseline <strong class="text-toned">{{ row.baselineStatus ?? '—' }}</strong></span>
            <span>Market profile <strong class="text-toned">{{ row.profileSessions ?? '—' }} sessions</strong></span>
          </div>
        </details>
      </article>
    </div>

    <div class="market-table surface-panel hidden overflow-x-auto rounded-2xl sm:block">
      <UTable :data="props.rows" :columns="columns">
        <template #ticker-cell="{ row }">
          <NuxtLink :to="`/board/${row.original.ticker}`" class="font-mono font-black text-highlighted hover:text-primary">
            {{ row.original.ticker }}
          </NuxtLink>
        </template>
        <template #mentions-cell="{ row }">
          {{ fmtInt(row.original.mentions) }}
        </template>
        <template #authors-cell="{ row }">
          {{ fmtInt(row.original.authors) }}
        </template>
        <template #sov-cell="{ row }">
          {{ fmtSov(row.original.sov) }}
        </template>
        <template #velocity-cell="{ row }">
          {{ fmt2(row.original.velocity) }}
        </template>
        <template #accel-cell="{ row }">
          {{ fmt2(row.original.accel) }}
        </template>
        <template #z-cell="{ row }">
          {{ fmt2(row.original.z) }}
        </template>
        <template #netDir-cell="{ row }">
          {{ fmt2(row.original.netDir) }}
        </template>
        <template #ddCount-cell="{ row }">
          {{ fmtInt(row.original.ddCount) }}
        </template>
        <template #baselineStatus-cell="{ row }">
          {{ row.original.baselineStatus ?? '—' }}
        </template>
        <template #hE-cell="{ row }">
          {{ fmt2(row.original.hE) }}
        </template>
        <template #divergence-cell="{ row }">
          {{ fmt2(row.original.divergence) }}
        </template>
        <template #quadrant-cell="{ row }">
          <QuadrantBadge :quadrant="row.original.quadrant" />
        </template>
        <template #rankDelta-cell="{ row }">
          {{ fmtRankDelta(row.original.rankDelta) }}
        </template>
        <template #ret-cell="{ row }">
          {{ fmtRet(row.original.ret) }}
        </template>
        <template #rvol-cell="{ row }">
          {{ fmtRvol(row.original.rvol) }}
        </template>
        <template #hM-cell="{ row }">
          {{ fmt2(row.original.hM) }}
        </template>
      </UTable>
    </div>
    <p class="px-1 text-xs leading-relaxed text-muted">
      Market overlay (ret/rvol/H_m) is <strong>day-to-date</strong>, not aligned to the 1h WSB window.
      Rvol is low-confidence on free IEX volume and structurally small early in the session.
      Divergence and quadrants appear only where supported market evidence is available.
    </p>
  </div>
</template>
