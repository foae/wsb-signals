/** A sleep that resolves early when `signal` aborts (so SIGTERM doesn't wait out a full interval).
 *  Shared by the radar loop and the plays queue loop (both recursive-timeout loops — never setInterval). */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
