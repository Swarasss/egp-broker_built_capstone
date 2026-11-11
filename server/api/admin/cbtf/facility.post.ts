import { defineEventHandler, readBody, createError } from 'h3'
import prisma from '@@/server/utils/db'
import { cbtfFacilityConfigSchema } from '@@/shared/schemas/cbtf.schema'
import type { ApiResponse } from '@@/shared/types/api'

export default defineEventHandler(async (event): Promise<ApiResponse<any>> => {
  const session = await getUserSession(event)
  if (!session?.user) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  if (session.user.globalRole !== 'ADMIN') {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  const body = await readBody(event)
  const validation = cbtfFacilityConfigSchema.omit({ seatAllocationOrder: true }).safeParse(body)
  if (!validation.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid facility parameters',
      data: validation.error.flatten()
    })
  }
  const seatAllocationOrder =
    body.seatAllocationOrder ??
    Array.from({ length: validation.data.totalSeats }, (_, i) => i + 1)
  const config = cbtfFacilityConfigSchema.safeParse({ ...validation.data, seatAllocationOrder })
  if (!config.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid facility parameters',
      data: config.error.flatten()
    })
  }

  const facility = await prisma.cbtfFacility.create({
    data: config.data,
    include: { operatingHours: true, scheduleExceptions: true }
  })
  return { statusCode: 201, data: facility }
})
