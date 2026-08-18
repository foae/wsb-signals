export * from './schema'
export * from './helpers'
export * from './constants'
export * from './plays'

import {
  rawPosts, rawComments, mentions, empiricalFeatures, analyticalFeatures,
  marketMovers, tickerNames, cycleRuns, signals,
  plays, playExtractions, playInterpretations, playMarks, playLinks,
} from './schema'

// Inferred row/insert types — the single-source-of-truth payoff (worker writes, web reads, same types).
export type RawPostRow = typeof rawPosts.$inferSelect
export type RawPostInsert = typeof rawPosts.$inferInsert
export type RawCommentRow = typeof rawComments.$inferSelect
export type RawCommentInsert = typeof rawComments.$inferInsert
export type MentionRow = typeof mentions.$inferSelect
export type MentionInsert = typeof mentions.$inferInsert
export type EmpiricalFeatureRow = typeof empiricalFeatures.$inferSelect
export type EmpiricalFeatureInsert = typeof empiricalFeatures.$inferInsert
export type AnalyticalFeatureRow = typeof analyticalFeatures.$inferSelect
export type AnalyticalFeatureInsert = typeof analyticalFeatures.$inferInsert
export type MarketMoverRow = typeof marketMovers.$inferSelect
export type MarketMoverInsert = typeof marketMovers.$inferInsert
export type TickerNameRow = typeof tickerNames.$inferSelect
export type TickerNameInsert = typeof tickerNames.$inferInsert
export type CycleRunRow = typeof cycleRuns.$inferSelect
export type CycleRunInsert = typeof cycleRuns.$inferInsert
export type SignalRow = typeof signals.$inferSelect
export type SignalInsert = typeof signals.$inferInsert
export type PlayRow = typeof plays.$inferSelect
export type PlayInsert = typeof plays.$inferInsert
export type PlayExtractionRow = typeof playExtractions.$inferSelect
export type PlayExtractionInsert = typeof playExtractions.$inferInsert
export type PlayInterpretationRow = typeof playInterpretations.$inferSelect
export type PlayInterpretationInsert = typeof playInterpretations.$inferInsert
export type PlayMarkRow = typeof playMarks.$inferSelect
export type PlayMarkInsert = typeof playMarks.$inferInsert
export type PlayLinkRow = typeof playLinks.$inferSelect
export type PlayLinkInsert = typeof playLinks.$inferInsert
