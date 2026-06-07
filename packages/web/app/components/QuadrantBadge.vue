<script setup lang="ts">
import type { Quadrant } from '~/types/board'

const props = defineProps<{
  quadrant: Quadrant | null
}>()

type BadgeColor = 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'error' | 'neutral'

const colorMap: Record<Quadrant, BadgeColor> = {
  CONFIRMED: 'success',
  HYPE: 'warning',
  STEALTH: 'info',
  QUIET: 'neutral',
}

const titleMap: Record<Quadrant, string> = {
  CONFIRMED: 'chatter + action agree',
  HYPE: 'loud, no market follow-through yet',
  STEALTH: 'market moving, WSB hasn\'t noticed',
  QUIET: 'neither hot',
}
</script>

<template>
  <span v-if="props.quadrant == null">—</span>
  <UBadge
    v-else
    :color="colorMap[props.quadrant]"
    :label="props.quadrant"
    :title="titleMap[props.quadrant]"
    variant="subtle"
    size="sm"
  />
</template>
