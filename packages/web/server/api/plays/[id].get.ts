/**
 * GET /api/plays/:id — one play + its current extraction/interpretation runs for the detail page.
 * Same contract style as the list: read via the shared util, Zod-validate the assembled payload,
 * DB failure → 503; unknown id → 404.
 */
import { PlayDetailSchema, readPlayDetail } from '../../utils/plays'
import { useDb } from '../../utils/db'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  // Reddit base36 post ids — reject junk before it reaches the DB.
  if (!id || !/^[a-z0-9]{1,16}$/i.test(id)) {
    throw createError({ statusCode: 400, statusMessage: 'invalid play id' })
  }

  let detail
  try {
    detail = await readPlayDetail(useDb(), id)
  } catch (err) {
    throw createError({ statusCode: 503, statusMessage: 'plays unavailable', cause: err })
  }
  if (!detail) throw createError({ statusCode: 404, statusMessage: 'play not found' })
  return PlayDetailSchema.parse(detail)
})
