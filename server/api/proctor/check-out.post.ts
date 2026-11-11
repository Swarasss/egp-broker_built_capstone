import { defineEventHandler, readBody, createError } from 'h3'
import prisma from '@@/server/utils/db'
import { checkOutReservation } from '@@/server/utils/cbtf'
import type { ApiResponse } from '@@/shared/types/api'

export default defineEventHandler(async (event): Promise<ApiResponse<any>> => {
  const session = await getUserSession(event)
  if (!session?.user) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  const role = session.user.globalRole
  if (role !== 'PROCTOR' && role !== 'ADMIN') {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  const body = await readBody(event)
  const reservationId = body?.reservationId

  if (!reservationId || typeof reservationId !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'Reservation ID is required' })
  }

  const studentId = body?.studentId
  if (studentId !== undefined && (typeof studentId !== 'string' || !studentId.trim())) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid student ID' })
  }

  const updated = await checkOutReservation(prisma as any, reservationId, session.user.id, studentId?.trim())

  return {
    statusCode: 200,
    data: updated
  }
})
