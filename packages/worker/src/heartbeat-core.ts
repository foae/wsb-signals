/**
 * Heartbeat verdict — the pure decision logic, split out from the CLI entry (`heartbeat.ts`) so the entry
 * can call `main()` UNCONDITIONALLY (like `build-whitelist.ts`) instead of guarding on an `import.meta.url ===
 * process.argv[1]` check. That guard is fragile for a Docker HEALTHCHECK: if a future tsx/loader change
 * ever broke it, `main()` would silently never run and the container would report healthy on a dead tap.
 * Keeping the testable logic here means tests import THIS module, never the side-effectful entry.
 */
export interface HeartbeatVerdict {
  code: 0 | 1 | 2
  status: 'OK' | 'STALE' | 'NO-DATA'
  detail: string
}

/**
 * Coverage verdict for the two independently indexed content kinds. This deliberately supersedes the
 * oracle's `min(lags)` rule: posts and comments both feed SoV, so one fresh kind cannot mask a
 * missing/stale peer. `0` OK / `1` STALE / `2` NO-DATA.
 */
export function heartbeatVerdict(
  lagComments: number | null,
  lagPosts: number | null,
  threshold: number,
): HeartbeatVerdict {
  const detail =
    (lagComments != null ? `comment=${(lagComments / 60).toFixed(1)} min` : 'comment=?') +
    (lagPosts != null ? `, post=${(lagPosts / 60).toFixed(1)} min` : ', post=?') +
    `; threshold=${(threshold / 60).toFixed(0)} min`

  if (lagComments == null || lagPosts == null) return { code: 2, status: 'NO-DATA', detail }
  if (Math.max(lagComments, lagPosts) <= threshold) return { code: 0, status: 'OK', detail }
  return { code: 1, status: 'STALE', detail }
}
