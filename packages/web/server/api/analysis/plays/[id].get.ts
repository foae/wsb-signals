/** GET /api/analysis/plays/:id — served-run audit plus nearby finalized heat context. */
import { ANALYSIS_QUERY_TIMEOUT_SECONDS } from '@wsb/shared'

import { AnalysisBusyError, PlayAuditQuerySchema, readPlayAudit, withAnalysisSlot } from '../../../utils/analysis'
import { useDb } from '../../../utils/db'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id || !/^[a-z0-9]{1,16}$/i.test(id)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid play id' })
  }
  const parsed = PlayAuditQuerySchema.safeParse(getQuery(event))
  if (!parsed.success) {
    throw createError({ statusCode: 400, statusMessage: 'invalid play analysis query', cause: parsed.error })
  }

  let audit
  try {
    audit = await withAnalysisSlot(() => readPlayAudit(useDb(), id, parsed.data))
  } catch (error) {
    if (error instanceof AnalysisBusyError) {
      setResponseHeader(event, 'Retry-After', ANALYSIS_QUERY_TIMEOUT_SECONDS)
      throw createError({ statusCode: 429, statusMessage: error.message })
    }
    throw createError({ statusCode: 503, statusMessage: 'play analysis unavailable', cause: error })
  }
  if (!audit) throw createError({ statusCode: 404, statusMessage: 'play not found' })
  return audit
})
