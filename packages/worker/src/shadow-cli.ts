/**
 * shadow-diff CLI (slice 9 — the cutover gate). Pairs the worker's per-cycle dumps against the oracle
 * truth (`oracle/replay.py` output) by `window_start`, runs the pure `diffCycle`, prints a report, and
 * **exits non-zero on any DRIFT** so CI / a human can gate cutover on "parity holds" (v2-porting-spec §9).
 *
 *   pnpm -C packages/worker shadow-diff <tsDir> <oracleDir> [--json <report.json>] [--quiet]
 *
 * `tsDir`     = the worker's `--shadow` output (default data/shadow)
 * `oracleDir` = `oracle/replay.py`'s output over that same tsDir
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { findRoot } from './config'
import { diffCycle, summarize, type CycleDiff, type OracleDump } from './shadow-diff'
import type { CycleDump } from './shadow'

function loadDir<T extends { window_start: number }>(dir: string): Map<number, T> {
  const out = new Map<number, T>()
  for (const name of readdirSync(dir)) {
    if (!name.startsWith('cycle-') || !name.endsWith('.json')) continue
    const obj = JSON.parse(readFileSync(join(dir, name), 'utf8')) as T
    out.set(obj.window_start, obj)
  }
  return out
}

function fmtCycle(d: CycleDiff): string {
  const lines: string[] = []
  const ts = new Date(d.window_start * 1000).toISOString().replace('.000Z', 'Z')
  lines.push(`  [${d.verdict}] window ${d.window_start} (${ts}) — ${d.counts.features} tickers, ${d.counts.mentions} mentions`)
  for (const f of d.fatal) lines.push(`      FATAL ${f}`)
  if (d.wordset_mismatch) lines.push('      ⚠ WORDSET MISMATCH — replay used different wordlists; B3 mention diffs are a SETUP error (re-build symbols.txt)')
  for (const t of d.membership.missing_in_ts) lines.push(`      MISSING in TS:     ${t}`)
  for (const t of d.membership.missing_in_oracle) lines.push(`      MISSING in oracle: ${t}`)
  for (const fd of d.field_diffs) {
    lines.push(`      ${fd.verdict} ${fd.ticker}.${fd.field}: ts=${JSON.stringify(fd.ts)} oracle=${JSON.stringify(fd.oracle)}`)
  }
  for (const ov of d.order_violations) {
    lines.push(`      ${ov.verdict} order @${ov.i}: ts has [${ov.tsPair[0]}, ${ov.tsPair[1]}] (h_e gap ${ov.gap.toExponential(3)}, wobble ${ov.wobble.toExponential(3)})`)
  }
  for (const md of d.mention_diffs) {
    const tag = d.wordset_mismatch ? 'wordset' : 'DRIFT'
    lines.push(`      ${tag} mention ${md.ticker}@${md.thing_id}.${md.field}: ts=${JSON.stringify(md.ts)} oracle=${JSON.stringify(md.oracle)}`)
  }
  if (d.readback && !d.readback.ok) {
    lines.push(`      DRIFT read-back: persisted board diverges (cycle_run=${d.readback.cycle_run})`)
    for (const rb of d.readback.diffs) {
      lines.push(`        ${rb.table}${rb.ticker ? `.${rb.ticker}` : ''}.${rb.field}: in_memory=${JSON.stringify(rb.in_memory)} persisted=${JSON.stringify(rb.persisted)}`)
    }
  }
  return lines.join('\n')
}

function main(): void {
  const args = process.argv.slice(2)
  const quiet = args.includes('--quiet')
  const allowUnpaired = args.includes('--allow-unpaired')
  const jsonIdx = args.indexOf('--json')
  const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : undefined
  const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--json')
  const [tsDir, oracleDir] = positional
  if (!tsDir || !oracleDir) {
    console.error('usage: shadow-diff <tsDir> <oracleDir> [--json <report.json>] [--quiet] [--allow-unpaired]')
    process.exit(2)
  }

  // Resolve relative dirs against the project root — where `start --shadow` (via findRoot) and
  // `oracle/replay.py` (run from root) write their dumps. pnpm runs this script with cwd =
  // packages/worker, so the documented `shadow-diff data/shadow data/shadow-oracle` would otherwise
  // resolve to packages/worker/data/* and ENOENT. Absolute paths pass through unchanged.
  const root = findRoot()
  const resolveDir = (p: string): string => (isAbsolute(p) ? p : join(root, p))
  const tsPath = resolveDir(tsDir)
  const orPath = resolveDir(oracleDir)
  const jsonPath = jsonOut ? resolveDir(jsonOut) : undefined

  const tsCycles = loadDir<CycleDump>(tsPath)
  const orCycles = loadDir<OracleDump>(orPath)
  const onlyTs = [...tsCycles.keys()].filter((k) => !orCycles.has(k)).sort((a, b) => a - b)
  const onlyOr = [...orCycles.keys()].filter((k) => !tsCycles.has(k)).sort((a, b) => a - b)
  const shared = [...tsCycles.keys()].filter((k) => orCycles.has(k)).sort((a, b) => a - b)

  const diffs = shared.map((k) => diffCycle(tsCycles.get(k)!, orCycles.get(k)!))
  const report = summarize(diffs)
  const wordsetMismatches = diffs.filter((d) => d.wordset_mismatch).length

  // SETUP failures (distinct from a parity DRIFT) — the gate can't certify parity if nothing was paired,
  // if cycles went undiffed (a stale/half replay, schema-version skips), or if the wordlists differed.
  const setupErrors: string[] = []
  if (shared.length === 0) setupErrors.push('0 paired cycles — nothing was validated (wrong dirs, or replay produced no output / all schema-skipped)')
  if ((onlyTs.length || onlyOr.length) && !allowUnpaired) {
    setupErrors.push(`${onlyTs.length} ts-only + ${onlyOr.length} oracle-only cycle(s) went undiffed (stale/partial replay; pass --allow-unpaired to ignore)`)
  }
  if (wordsetMismatches > 0) setupErrors.push(`${wordsetMismatches} cycle(s) had a WORDSET MISMATCH — re-build symbols.txt so replay uses the worker's wordlists`)

  if (!quiet) {
    console.log(`\nshadow-diff: ${tsPath} ⟷ ${orPath}`)
    console.log(`  paired ${shared.length} cycle(s); ts-only ${onlyTs.length}, oracle-only ${onlyOr.length}`)
    for (const d of diffs) console.log(fmtCycle(d))
    console.log(
      `\n  TOTALS: ${report.totals.cycles} cycles → ${report.totals.match} MATCH, ` +
      `${report.totals.near} NEAR, ${report.totals.drift} DRIFT`,
    )
    for (const e of setupErrors) console.log(`  SETUP ERROR: ${e}`)
    const overall = setupErrors.length ? 'SETUP-ERROR' : report.verdict
    console.log(`  VERDICT: ${overall}\n`)
  }
  if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify({ ...report, onlyTs, onlyOr, setupErrors }, null, 2)}\n`)

  // Exit codes: 1 = DRIFT (a real parity failure), 2 = SETUP error (gate couldn't certify), 0 = parity holds.
  if (report.verdict === 'DRIFT') process.exit(1)
  process.exit(setupErrors.length ? 2 : 0)
}

main()
