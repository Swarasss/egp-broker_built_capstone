import { defineEventHandler, getQuery, createError } from 'h3'
import prisma from '@@/server/utils/db'
import type { ApiResponse } from '@@/shared/types/api'
import type { CbtfSeatMapResponse } from '@@/shared/models/cbtf'

/**
 * Admin view of every physical seat and its certifications.
 * Seats without a CbtfSeat row are ordinary seats with no properties.
 */
export default defineEventHandler(async (event): Promise<ApiResponse<CbtfSeatMapResponse>> => {
  const session = await getUserSession(event)
  if (!session?.user) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  if (session.user.globalRole !== 'ADMIN') {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  const query = getQuery(event)
  const facility = query.facilityId
    ? await prisma.cbtfFacility.findUnique({ where: { id: String(query.facilityId) } })
    : await prisma.cbtfFacility.findFirst({ orderBy: { createdAt: 'asc' } })

  if (!facility) {
    throw createError({ statusCode: 404, statusMessage: 'Testing facility not found' })
  }

  const rows = await prisma.cbtfSeat.findMany({
    where: { facilityId: facility.id },
    select: { seatNumber: true, properties: true }
  })
  const propertiesBySeat = new Map(rows.map((row) => [row.seatNumber, row.properties]))

  const seats = Array.from({ length: facility.totalSeats }, (_, index) => ({
    seatNumber: index + 1,
    properties: propertiesBySeat.get(index + 1) ?? []
  }))

  return {
    statusCode: 200,
    data: {
      facilityId: facility.id,
      facilityName: facility.name,
      totalSeats: facility.totalSeats,
      seats
    }
  }
})
