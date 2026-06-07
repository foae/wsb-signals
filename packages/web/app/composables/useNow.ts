/**
 * Reactive "now" in epoch seconds. 0 during SSR (so relative-time renders empty server-side → no
 * hydration mismatch), then set on mount AND refreshed on an interval so a long-open page's staleness /
 * "ago" stays honest. Without the interval, `nowSeconds` was captured once at mount and drifted — a page
 * left open eventually mis-flags fresh data as stale (review-gate finding).
 */
export function useNow(intervalMs = 30_000) {
  const now = ref(0)
  let timer: ReturnType<typeof setInterval> | undefined
  onMounted(() => {
    now.value = Date.now() / 1000
    timer = setInterval(() => { now.value = Date.now() / 1000 }, intervalMs)
  })
  onUnmounted(() => { if (timer) clearInterval(timer) })
  return now
}
