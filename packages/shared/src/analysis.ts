/** Stable, agent-facing analysis contract shared by the web API and export CLI. */
export const ANALYSIS_SCHEMA_VERSION = 'analysis-v1' as const
/** Plausibility bounds for recent WSB/market analysis timestamps (2010-01-01 through 2100-01-01). */
export const ANALYSIS_MIN_EPOCH_SECONDS = 1_262_304_000
export const ANALYSIS_MAX_EPOCH_SECONDS = 4_102_444_800
export const ANALYSIS_QUERY_TIMEOUT_SECONDS = 15

export const ANALYSIS_CAVEAT_CODES = [
  'selection-bias', 'extraction-uncertainty', 'posted-vs-outcome', 'non-causal',
  'no-ticker-win-rate', 'capped-window', 'finalization-approximation',
] as const

export type AnalysisCaveatCode = (typeof ANALYSIS_CAVEAT_CODES)[number]

export const ANALYSIS_CAVEATS = {
  'selection-bias': 'WSB screenshot posts are self-selected; gains are overrepresented and the captured corpus is not representative of traders or trades.',
  'extraction-uncertainty': 'Positions, labels, dates, and P&L are model-extracted from screenshots and can be wrong; use confidence and stored provenance.',
  'posted-vs-outcome': 'Posted P&L is what the screenshot showed at post time. It is not a tracked outcome and must not be treated as one.',
  'non-causal': 'Heat and play proximity are observational context, not evidence that attention caused an outcome and not a trading recommendation.',
  'no-ticker-win-rate': 'Never aggregate these per-post observations into a per-ticker win rate; survivorship and selection bias make that statistic misleading.',
  'capped-window': 'A capped radar window is undercounted; its share-of-voice and derived heat are low-trust.',
  'finalization-approximation': 'Longitudinal heat includes only rows with an explicit finalized_at marker. After an outage, stable windows remain excluded until the next successful cycle repairs their dependent signals and finalizes them.',
} as const satisfies Record<AnalysisCaveatCode, string>

export const OUTCOME_TRACKING_CAPABILITY = {
  status: 'tracking_not_implemented',
  marksAvailable: false,
} as const
