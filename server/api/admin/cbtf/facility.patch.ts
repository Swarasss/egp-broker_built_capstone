import { defineEventHandler, readBody, createError } from 'h3'
import { z } from 'zod'
import prisma from '@@/server/utils/db'
import { updateFacilityInputSchema } from '@@/shared/schemas/cbtf.schema'
import type { ApiResponse } from '@@/shared/types/api'
import { getFacilitySeatAllocationOrder } from '@@/server/utils/cbtf'

export default defineEventHandler(async (event): Promise<ApiResponse<any>> => {
  const session = await getUserSession(event)
  if (!session?.user) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  if (session.user.globalRole !== 'ADMIN') {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  const body = await readBody(event)
  const validation = updateFacilityInputSchema
    .extend({ facilityId: z.string().min(1) })
    .safeParse(body)
  if (!validation.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid facility update parameters',
      data: validation.error.flatten()
    })
  }

  const facility = await prisma.cbtfFacility.findUnique({
    where: { id: validation.data.facilityId }
  })
  if (!facility) {
    throw createError({ statusCode: 404, statusMessage: 'Facility not found' })
  }
  const data: Record<string, any> = {}

  if (validation.data.name !== undefined) {
    data.name = validation.data.name
  }

  if (validation.data.totalSeats !== undefined) {
    data.totalSeats = validation.data.totalSeats
  }

  if (validation.data.seatAllocationOrder !== undefined) {
    data.seatAllocationOrder = validation.data.seatAllocationOrder
  } else if (validation.data.totalSeats !== undefined && validation.data.totalSeats !== facility.totalSeats) {
    const order = new Set(getFacilitySeatAllocationOrder(facility).slice(0, validation.data.totalSeats))
    for (let seat = 1; order.size < validation.data.totalSeats; seat++) {
      order.add(seat)
    }
    data.seatAllocationOrder = [...order]
  }

  if (validation.data.checkInLeadMinutes !== undefined) {
    data.checkInLeadMinutes = validation.data.checkInLeadMinutes
  }

  if (validation.data.checkInGraceMinutes !== undefined) {
    data.checkInGraceMinutes = validation.data.checkInGraceMinutes
  }

  if (validation.data.timezone !== undefined) {
    data.timezone = validation.data.timezone
  }

  const updated = await prisma.cbtfFacility.update({
    where: { id: facility.id },
    data,
    include: {
      operatingHours: true,
      scheduleExceptions: true
    }
  })

  return {
    statusCode: 200,
    data: updated
  }
})
