/**
 * Pure formatting helpers — match the v0.0.1 Streamlit oracle exactly
 * (`wsb_signals/dashboard.py` lines ~302–318 at tag `v0.0.1`; tree pruned from main).
 */

/** Share-of-voice: null → '—', else e.g. "28.5%" */
export function fmtSov(v: number | null | undefined): string {
  if (v == null) return '—'
  return (v * 100).toFixed(1) + '%'
}

/** Price return: null → '—', else signed e.g. "+2.3%" or "-1.1%" */
export function fmtRet(v: number | null | undefined): string {
  if (v == null) return '—'
  const pct = v * 100
  const sign = pct >= 0 ? '+' : ''
  return sign + pct.toFixed(1) + '%'
}

/** Relative volume: null → '—', else e.g. "×1.45" */
export function fmtRvol(v: number | null | undefined): string {
  if (v == null) return '—'
  return '×' + v.toFixed(2)
}

/** 2-decimal float: null → '—', else e.g. "0.73" (for hE, hM, netDir, z, velocity, accel, divergence) */
export function fmt2(v: number | null | undefined): string {
  if (v == null) return '—'
  return v.toFixed(2)
}

/** Integer: null → '—', else String(v) */
export function fmtInt(v: number | null | undefined): string {
  if (v == null) return '—'
  return String(v)
}

/** Rank delta: null → '—', else signed integer e.g. "+3", "-2", "0" */
export function fmtRankDelta(v: number | null | undefined): string {
  if (v == null) return '—'
  if (v > 0) return '+' + v
  return String(v)
}

/** Absolute dollars (plays P&L — already-signed values): null → '—', else "$1,234.56" / "-$12.30".
 *  Locale pinned to en-US so SSR and client render identically (no hydration mismatch). */
export function fmtUsd(v: number | null | undefined): string {
  if (v == null) return '—'
  const abs = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return (v < 0 ? '-$' : '$') + abs
}

/** Signed dollars: like fmtUsd but gains carry an explicit '+' ("+$318.00"). */
export function fmtSignedUsd(v: number | null | undefined): string {
  if (v == null) return '—'
  return (v >= 0 ? '+' : '') + fmtUsd(v)
}

/** Percent for values ALREADY in percent units (plays pnl_pct — unlike fmtRet's fractions):
 *  null → '—', else signed "+42.3%" / "-88.0%". */
export function fmtPctPoints(v: number | null | undefined): string {
  if (v == null) return '—'
  return (v >= 0 ? '+' : '') + v.toFixed(1) + '%'
}

/** Relative time: "Xm ago" / "Xs ago" / "Xh ago" */
export function fmtAgo(epochSeconds: number, nowSeconds: number): string {
  const diff = nowSeconds - epochSeconds
  if (diff < 60) return Math.floor(diff) + 's ago'
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago'
  return Math.floor(diff / 3600) + 'h ago'
}

/** UTC datetime as "YYYY-MM-DD HH:MM" */
export function fmtUtc(epochSeconds: number, includeDate = true): string {
  const d = new Date(epochSeconds * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  const time = pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes())
  if (!includeDate) return time
  return (
    d.getUTCFullYear() +
    '-' +
    pad(d.getUTCMonth() + 1) +
    '-' +
    pad(d.getUTCDate()) +
    ' ' +
    time
  )
}
