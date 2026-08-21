/** GET /api/analysis/tickers/:ticker — bounded finalized heat history plus published play anchors. */
import { ANALYSIS_QUERY_TIMEOUT_SECONDS } from '@wsb/shared'

import {
  AnalysisBusyError, AnalysisInputError, TickerDossierQuerySchema, readTickerDossier,
  resolveDossierRange, withAnalysisSlot,
} from '../../../utils/analysis'
import { useDb } from '../../../utils/db'

export default defineEventHandler(async (event) => {
  const rawTicker = getRouterParam(event, 'ticker')
  const ticker = rawTicker?.toUpperCase()
  if (!ticker || !/^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(ticker)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid ticker' })
  }
  const parsed = TickerDossierQuerySchema.safeParse(getQuery(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'invalid ticker analysis query', cause: parsed.error })
  }

  let range
  try {
    range = resolveDossierRange(parsed.data)
  } catch (error) {
    if (error instanceof AnalysisInputError) {
      throw createError({ statusCode: 400, statusMessage: error.message })
    }
    throw error
  }

  try {
    return await withAnalysisSlot(() => readTickerDossier(useDb(), ticker, range))
  } catch (error) {
    if (error instanceof AnalysisBusyError) {
      setResponseHeader(event, 'Retry-After', ANALYSIS_QUERY_TIMEOUT_SECONDS)
      throw createError({ statusCode: 429, statusMessage: error.message })
    }
    throw createError({ statusCode: 503, statusMessage: 'ticker analysis unavailable', cause: error })
  }
})
