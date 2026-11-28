import { defineEventHandler, readBody, createError } from 'h3'
import prisma from '@@/server/utils/db'
import { checkInReservation } from '@@/server/utils/cbtf'
import { lockCbtfFacilities } from '@@/server/utils/cbtf-placement'
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
  if (typeof studentId !== 'string' || !studentId.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'Student ID is required' })
  }

  const updated = await prisma.$transaction(async (tx) => {
    await lockCbtfFacilities(tx)
    return checkInReservation(tx, reservationId, session.user.id, studentId.trim())
  }, { isolationLevel: 'ReadCommitted' })

  return {
    statusCode: 200,
    data: updated
  }
})
