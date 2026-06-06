export * from './schema'

import {
  rawPosts, rawComments, mentions, empiricalFeatures, analyticalFeatures,
  marketMovers, tickerNames, cycleRuns, signals,
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
