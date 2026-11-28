import { defineEventHandler, getRouterParam, readBody, createError } from 'h3'
import prisma from '@@/server/utils/db'
import { cbtfSeatOutOfServiceInputSchema } from '@@/shared/schemas/cbtf.schema'
import { takeSeatOutOfService } from '@@/server/utils/cbtf-workstations'
import type { ApiResponse } from '@@/shared/types/api'

/**
 * Takes a workstation out of service. Proctors and admins may do this.
 * Affected reservations are flagged for staff to move.
 */
export default defineEventHandler(async (event): Promise<ApiResponse<any>> => {
  const session = await getUserSession(event)
  if (!session?.user) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  const role = session.user.globalRole
  if (role !== 'PROCTOR' && role !== 'ADMIN') {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  const seatNumber = Number(getRouterParam(event, 'seatNumber'))
  if (!Number.isInteger(seatNumber) || seatNumber < 1) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid seat number' })
  }

  const body = await readBody(event)
  const validation = cbtfSeatOutOfServiceInputSchema.safeParse(body)
  if (!validation.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid out-of-service request',
      data: validation.error.flatten()
    })
  }

  const result = await prisma.$transaction((tx) =>
    takeSeatOutOfService(tx, {
      facilityId: validation.data.facilityId,
      seatNumber,
      reason: validation.data.reason,
      userId: session.user.id
    }),
    { isolationLevel: 'ReadCommitted' }
  )

  return { statusCode: 200, data: result }
})
