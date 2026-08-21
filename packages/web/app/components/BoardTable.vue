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
  <div class="space-y-2">
    <p class="sm:hidden text-xs font-medium text-muted">
      Swipe horizontally for the full market overlay →
    </p>
    <div class="market-table surface-panel overflow-x-auto rounded-2xl">
      <UTable :data="props.rows" :columns="columns">
        <template #ticker-cell="{ row }">
          <NuxtLink :to="`/?ticker=${row.original.ticker}`" class="font-mono font-black text-highlighted hover:text-primary">
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
      Divergence and quadrants are live; lead-lag stays disabled until H_m is window-aligned.
    </p>
  </div>
</template>
