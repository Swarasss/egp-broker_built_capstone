import { defineEventHandler, getRouterParam, readBody, createError } from 'h3'
import prisma from '@@/server/utils/db'
import { cbtfMoveSeatInputSchema } from '@@/shared/schemas/cbtf.schema'
import { moveReservationToSeat } from '@@/server/utils/cbtf-workstations'
import type { ApiResponse } from '@@/shared/types/api'

/**
 * Moves a reservation to a spare seat in the same facility.
 * Used when a workstation goes out of service (including mid-exam).
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

  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Reservation ID is required' })
  }

  const body = await readBody(event)
  const validation = cbtfMoveSeatInputSchema.safeParse(body ?? {})
  if (!validation.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid move-seat request',
      data: validation.error.flatten()
    })
  }

  const result = await prisma.$transaction((tx) =>
    moveReservationToSeat(tx as any, {
      reservationId: id,
      targetSeatNumber: validation.data.targetSeatNumber,
      userId: session.user.id
    })
  )

  return { statusCode: 200, data: result }
})
