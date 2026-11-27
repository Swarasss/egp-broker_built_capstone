import { defineEventHandler, createError, getQuery, setHeader } from 'h3'
import prisma from '@@/server/utils/db'
import { getProctorLiveFeed } from '@@/server/utils/cbtf'
import type { ApiResponse } from '@@/shared/types/api'

export default defineEventHandler(async (event): Promise<ApiResponse<any>> => {
  if (event.node?.res && typeof (event.node.res as any).setHeader === 'function') {
    setHeader(event, 'Cache-Control', 'no-cache, no-store, must-revalidate')
    setHeader(event, 'Pragma', 'no-cache')
    setHeader(event, 'Expires', '0')
  }

  const session = await getUserSession(event)
  if (!session?.user) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  const role = session.user.globalRole
  if (role !== 'PROCTOR' && role !== 'ADMIN') {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  const { facilityId } = getQuery(event)
  const feed = await getProctorLiveFeed(
    prisma,
    typeof facilityId === 'string' ? facilityId : undefined
  )

  return {
    statusCode: 200,
    data: feed
  }
})
