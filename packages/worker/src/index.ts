/**
 * Worker entrypoint — the standalone TS radar (porting-spec §7). Boots config + Postgres, acquires the
 * advisory lock, and runs the 5-minute poll loop until SIGTERM/SIGINT. Flags:
 *   --once       run a single cycle and exit
 *   --no-market  skip the Alpaca overlay (empirical-only)
 */
import { log } from './logger'
import { startWorker } from './loop'

const argv = new Set(process.argv.slice(2))

startWorker({ once: argv.has('--once'), noMarket: argv.has('--no-market') }).catch((e) => {
  log.error({ err: String(e) }, 'worker failed to start')
  process.exitCode = 1
})
