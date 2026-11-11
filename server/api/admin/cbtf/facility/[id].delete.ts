import { defineEventHandler, getRouterParam, createError } from 'h3'
import prisma from '@@/server/utils/db'
import type { ApiResponse } from '@@/shared/types/api'

export default defineEventHandler(async (event): Promise<ApiResponse<any>> => {
  const session = await getUserSession(event)
  if (!session?.user) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  if (session.user.globalRole !== 'ADMIN') {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'Facility ID is required' })
  }

  await prisma.$transaction(async (tx) => {
    // Prevent concurrent reservations/shifts from being inserted during deletion.
    const facilities = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "CbtfFacility" WHERE "id" = ${id} FOR UPDATE
    `
    if (!facilities.length) {
      throw createError({ statusCode: 404, statusMessage: 'Facility not found' })
    }
    const reservations = await tx.cbtfReservation.count({ where: { facilityId: id } })
    const shifts = await tx.cbtfProctorShift.count({ where: { facilityId: id } })
    if (reservations || shifts) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Cannot delete a facility with reservations or proctor shifts'
      })
    }
    await tx.cbtfFacility.delete({ where: { id } })
  })

  return { statusCode: 200, data: { success: true } }
})
