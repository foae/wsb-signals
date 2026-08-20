/** Shared plays display maps — used by both the card grid and the detail page so colors can't drift. */

type BadgeColor = 'success' | 'error' | 'warning' | 'info' | 'neutral' | 'primary'

/** Flair → badge color (Gain green / Loss red / YOLO amber). */
export function flairColor(flair: string | null): BadgeColor {
  if (flair === 'Gain') return 'success'
  if (flair === 'Loss') return 'error'
  if (flair === 'YOLO') return 'warning'
  return 'neutral'
}

/** Taxonomy v1 category → badge color (interpretation.ts CATEGORIES; unknown → neutral). */
export function categoryColor(category: string | null): BadgeColor {
  switch (category) {
    case 'disciplined-play': return 'success'
    case 'bag-holding': return 'error'
    case 'high-risk-high-reward':
    case 'earnings-gamble': return 'warning'
    case 'dumb-luck':
    case 'herd-following': return 'info'
    default: return 'neutral'
  }
}

/** Signed-value text color for P&L figures. */
export function pnlClass(v: number | null | undefined): string {
  if (v == null) return 'text-muted'
  return v >= 0 ? 'text-success' : 'text-error'
}
