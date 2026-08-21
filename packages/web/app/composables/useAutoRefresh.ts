import type { Ref } from 'vue'

/**
 * Client-side auto-refresh for SSR pages: re-runs the `useFetch`/`useAsyncData` `refresh` on an
 * interval, skipping while a fetch is already in flight, and cleans up on unmount.
 *
 * A *background* refresh failure must not blank the page: Nuxt resets `data` to its default on a
 * failed refresh (the asyncData error path), which would swap a fully rendered page for the error
 * alert on one transient blip. The interval therefore snapshots `data` before each refresh and
 * restores the last-good content if the refresh failed — the page's `v-if="error"` alert still
 * shows, and the next successful poll replaces the restored content. Initial-load failures are
 * untouched: `data` starts undefined, so nothing is restored and the alert shows as before.
 * Pass a `timeout` to the underlying `useFetch` so a hung request cannot hold `status ===
 * 'pending'` and stall every later tick.
 *
 * SSR renders the fresh snapshot; the interval keeps a long-open page fresh within `intervalMs` of
 * the worker's publish cadence — radar cycles ~5 min, the plays queue 60s (config.toml). Keep the
 * interval tuned to the data's cadence: 30s for the plays list (incremental publishes), 60s for
 * the heat board pages.
 */
export function useAutoRefresh<T>(
 data: Ref<T | undefined>,
 refresh: () => unknown,
 intervalMs: number,
 should?: () => boolean,
) {
 let timer: NodeJS.Timeout | undefined
 onMounted(() => {
  timer = setInterval(() => {
   if (should && !should()) return
   const before = data.value
   void Promise.resolve(refresh()).then(() => {
    if (data.value === undefined && before !== undefined) data.value = before
   })
  }, intervalMs)
 })
 onBeforeUnmount(() => {
  clearInterval(timer)
 })
}
