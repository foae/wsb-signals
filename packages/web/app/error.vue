<script setup lang="ts">
import type { NuxtError } from '#app'

const props = defineProps<{
  error: NuxtError
}>()

const notFound = computed(() => props.error.statusCode === 404)

function returnHome() {
  clearError({ redirect: '/' })
}
</script>

<template>
  <main class="page-shell max-w-3xl min-h-[calc(100vh-4rem)] grid place-items-center">
    <section class="surface-panel w-full overflow-hidden rounded-3xl p-7 sm:p-10 relative">
      <div class="absolute -right-12 -top-14 size-48 rounded-full bg-primary/10 blur-3xl" />
      <div class="relative">
        <p class="font-mono text-sm font-black tracking-wider text-primary">
          {{ error.statusCode || 500 }} / TAPE INTERRUPTED
        </p>
        <h1 class="mt-4 text-3xl sm:text-5xl font-black tracking-[-0.045em] text-highlighted">
          {{ notFound ? 'That play left the board.' : 'The tape hit a snag.' }}
        </h1>
        <p class="mt-4 max-w-xl text-base leading-relaxed text-muted">
          {{ notFound ? 'The link may be stale, or the play was never captured.' : 'The server could not render this page. Return to the live tape and try again.' }}
        </p>
        <p v-if="error.statusMessage && !notFound" class="mt-3 rounded-lg bg-muted px-3 py-2 font-mono text-xs text-toned">
          {{ error.statusMessage }}
        </p>
        <UButton
          class="mt-7"
          color="primary"
          size="lg"
          icon="i-lucide-arrow-left"
          label="Return to WSB Plays"
          @click="returnHome"
        />
      </div>
    </section>
  </main>
</template>
