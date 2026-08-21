/** GET /api/heat/tickers/:ticker — lightweight finalized history for the human board. */
import {
  AnalysisInputError, TickerDossierQuerySchema, readTickerHeatHistory, resolveDossierRange,
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
    throw createError({ statusCode: 400, statusMessage: 'invalid heat history query', cause: parsed.error })
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
    return await readTickerHeatHistory(useDb(), ticker, range)
  } catch (error) {
    throw createError({ statusCode: 503, statusMessage: 'ticker heat history unavailable', cause: error })
  }
})
