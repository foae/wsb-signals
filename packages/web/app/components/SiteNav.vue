<script setup lang="ts">
// Top nav — the P4 "Plays | Heat board" cross-link (product §4.5), landed early so the two screens
// are mutually reachable. Active state is computed by path prefix so /plays/:id keeps Plays lit
// (router-link active-class on '/' would light Heat board everywhere).
const route = useRoute()

const links = [
  { to: '/', label: 'Heat board' },
  { to: '/plays', label: 'Plays' },
]

const isActive = (to: string): boolean =>
  to === '/' ? route.path === '/' : route.path === to || route.path.startsWith(to + '/')
</script>

<template>
  <header class="border-b border-default">
    <nav class="max-w-screen-2xl mx-auto px-4 h-12 flex items-center gap-6">
      <span class="text-sm font-bold tracking-wide">WSB Signals</span>
      <NuxtLink
        v-for="l in links"
        :key="l.to"
        :to="l.to"
        class="text-sm hover:text-highlighted"
        :class="isActive(l.to) ? 'text-highlighted font-semibold' : 'text-muted'"
      >
        {{ l.label }}
      </NuxtLink>
    </nav>
  </header>
</template>
