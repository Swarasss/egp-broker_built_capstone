import { defineEventHandler, getRouterParam, readBody, createError } from 'h3'
import prisma from '@@/server/utils/db'
import { cbtfSeatReturnToServiceInputSchema } from '@@/shared/schemas/cbtf.schema'
import { returnSeatToService } from '@@/server/utils/cbtf-workstations'
import type { ApiResponse } from '@@/shared/types/api'

/** Returns a workstation to service. Proctors and admins may do this. */
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
  const validation = cbtfSeatReturnToServiceInputSchema.safeParse(body)
  if (!validation.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid return-to-service request',
      data: validation.error.flatten()
    })
  }

  const result = await prisma.$transaction((tx) =>
    returnSeatToService(tx as any, {
      facilityId: validation.data.facilityId,
      seatNumber,
      userId: session.user.id
    })
  )

  return { statusCode: 200, data: result }
})
