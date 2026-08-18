/**
 * Worker entrypoint — the standalone TS radar + plays loops (porting-spec §7, plays-plan §1). Boots
 * config + Postgres, acquires the advisory lock, and runs the 5-minute poll loop (plus the plays queue
 * when [plays] is enabled) until SIGTERM/SIGINT. Flags:
 *   --once       run a single radar cycle (+ one plays-queue tick) and exit
 *   --no-market  skip the Alpaca overlay (empirical-only)
 *
 * THIS FILE OWNS ALL PROCESS-LEVEL HANDLERS (plays-plan §1): the loops never install their own — a
 * per-loop copy of this block would race shutdown and double-handle exceptions. One SIGTERM/SIGINT
 * aborts the shared stop signal; every loop drains off it.
 */
import { log } from './logger'
import { startWorker } from './loop'

const argv = new Set(process.argv.slice(2))

const stop = new AbortController()
process.on('SIGTERM', () => stop.abort())
process.on('SIGINT', () => stop.abort())
// A stray unhandled rejection (outside every loop's per-tick try/catch) shouldn't kill the daemon — log it.
process.on('unhandledRejection', (r) =>
  log.error({ err: String(r) }, 'unhandledRejection — guarded; the daemon keeps running'))
// An uncaughtException means undefined process state — log and EXIT non-zero so the orchestrator
// restarts a clean process (continuing risks publishing corrupt/stale cycles). This is also why plays
// ticks must await every promise they start: one unguarded synchronous throw here kills the radar too.
process.on('uncaughtException', (e) => {
  log.error({ err: String(e) }, 'uncaughtException — exiting for a clean restart')
  process.exit(1)
})

startWorker({ once: argv.has('--once'), noMarket: argv.has('--no-market'), stopSignal: stop.signal }).catch((e) => {
  log.error({ err: String(e) }, 'worker failed to start')
  process.exitCode = 1
})
