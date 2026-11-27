import { defineEventHandler, getQuery, createError } from 'h3'
import prisma from '@@/server/utils/db'
import { getWorkstationSummary } from '@@/server/utils/cbtf-workstations'
import type { ApiResponse } from '@@/shared/types/api'
import type { CbtfWorkstationSummary } from '@@/shared/models/cbtf'

/**
 * Staff view of a facility's workstations (in service / spare / out of service).
 * Proctors and admins may read it.
 */
export default defineEventHandler(async (event): Promise<ApiResponse<CbtfWorkstationSummary>> => {
  const session = await getUserSession(event)
  if (!session?.user) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  const role = session.user.globalRole
  if (role !== 'PROCTOR' && role !== 'ADMIN') {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  const query = getQuery(event)
  const facility = query.facilityId
    ? await prisma.cbtfFacility.findUnique({
        where: { id: String(query.facilityId) },
        select: { id: true }
      })
    : await prisma.cbtfFacility.findFirst({
        orderBy: { createdAt: 'asc' },
        select: { id: true }
      })

  if (!facility) {
    throw createError({ statusCode: 404, statusMessage: 'Testing facility not found' })
  }

  const summary = await getWorkstationSummary(prisma as any, facility.id)
  return { statusCode: 200, data: summary }
})
