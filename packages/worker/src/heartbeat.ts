/**
 * Heartbeat CLI — port of `wsb_signals/cli.cmd_heartbeat` + `arctic_shift.newest_item_lag`.
 *
 * Docker healthcheck entry: probes Arctic-Shift freshness and exits with a load-bearing code:
 *   0 = OK (lag ≤ threshold)
 *   1 = STALE (lag > threshold; tap is degraded)
 *   2 = NO-DATA (tap is likely DOWN)
 *
 * This file is a thin entry that ALWAYS runs `main()` (like `build-whitelist.ts`); the
 * testable verdict logic lives in `heartbeat-core.ts`, so nothing imports this module and there is no
 * is-main guard to silently mis-fire for the healthcheck.
 */
import { buildSource, findRoot, loadConfig } from './config'
import { heartbeatVerdict } from './heartbeat-core'
import { log } from './logger'

async function main(): Promise<void> {
  const { raw, worker } = loadConfig(findRoot())
  const threshold = worker.maxStalenessSeconds

  const src = buildSource(raw)
  const lagC = await src.newestItemLag('comments')
  const lagP = await src.newestItemLag('posts')
  await src.close()

  const v = heartbeatVerdict(lagC, lagP, threshold)

  if (v.status === 'OK') {
    log.info({ status: v.status, lagC, lagP, threshold }, `HEARTBEAT OK — ${v.detail}`)
  } else if (v.status === 'STALE') {
    log.error(
      { status: v.status, lagC, lagP, threshold },
      `HEARTBEAT STALE — ${v.detail}. Lag exceeds threshold; treat the tap as degraded. ` +
        'Runbook: pause the radar, re-test Arctic-Shift (and PullPush) before resuming.',
    )
  } else {
    log.error(
      { status: v.status, lagC, lagP, threshold },
      'HEARTBEAT FAIL — Arctic-Shift returned no items; the sole live tap may be DOWN. ' +
        'Runbook: radar STOPS (no free fallback — PullPush frozen, Reddit API excluded).',
    )
  }

  process.exit(v.code)
}

main().catch((err: unknown) => {
  log.error({ err: String(err) }, 'heartbeat: unexpected error')
  process.exit(2)
})
