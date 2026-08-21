<script setup lang="ts">
// Top nav — the P4 "Plays | Heat board" cross-link (product §4.5). Plays is now the primary UI at
// '/'; the heat board lives at '/board'. Active state keeps Plays lit on /plays/:id detail pages
// (a plain exact-match on '/' would light nothing there).
const route = useRoute()

const links = [
  { to: '/', label: 'Plays' },
  { to: '/board', label: 'Heat board' },
]

const isActive = (to: string): boolean =>
  to === '/' ? (route.path === '/' || route.path.startsWith('/plays')) : route.path === to || route.path.startsWith(to + '/')
</script>

<template>
  <header class="sticky top-0 z-50 border-b border-default bg-default/90 backdrop-blur-xl">
    <nav class="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center gap-3 sm:gap-6" aria-label="Primary">
      <NuxtLink to="/" class="group flex items-center gap-2.5 shrink-0" aria-label="WSB Plays home">
        <span class="size-8 rounded-lg bg-inverted text-inverted grid place-items-center text-[10px] font-black tracking-tight shadow-sm group-hover:bg-primary transition-colors">
          WSB
        </span>
        <span class="text-sm font-black tracking-[-0.035em] text-highlighted">
          WSB <span class="text-primary">PLAYS</span>
        </span>
      </NuxtLink>

      <div class="flex items-center gap-1 rounded-lg bg-muted p-1">
        <NuxtLink
          v-for="l in links"
          :key="l.to"
          :to="l.to"
          class="rounded-md px-2.5 sm:px-3 py-1.5 text-xs sm:text-sm font-medium transition-colors"
          :class="isActive(l.to) ? 'bg-elevated text-highlighted shadow-sm' : 'text-muted hover:text-highlighted'"
        >
          {{ l.label }}
        </NuxtLink>
      </div>

      <div class="ml-auto">
        <UColorModeButton color="neutral" variant="ghost" size="sm" />
      </div>
    </nav>
  </header>
</template>
