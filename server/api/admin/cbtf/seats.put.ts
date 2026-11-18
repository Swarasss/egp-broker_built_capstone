import { defineEventHandler, readBody, createError } from 'h3'
import prisma from '@@/server/utils/db'
import { updateCbtfSeatsInputSchema } from '@@/shared/schemas/cbtf.schema'
import type { ApiResponse } from '@@/shared/types/api'
import type { CbtfSeatMapResponse } from '@@/shared/models/cbtf'

/**
 * Replaces the certification map for a facility's seats.
 * Seats submitted with no properties are stored as ordinary seats.
 */
export default defineEventHandler(async (event): Promise<ApiResponse<CbtfSeatMapResponse>> => {
  const session = await getUserSession(event)
  if (!session?.user) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  if (session.user.globalRole !== 'ADMIN') {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  const body = await readBody(event)
  const validation = updateCbtfSeatsInputSchema.safeParse(body)
  if (!validation.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid seat configuration',
      data: validation.error.flatten()
    })
  }

  const { facilityId, seats } = validation.data

  const facility = await prisma.cbtfFacility.findUnique({ where: { id: facilityId } })
  if (!facility) {
    throw createError({ statusCode: 404, statusMessage: 'Testing facility not found' })
  }

  const seatNumbers = seats.map((seat) => seat.seatNumber)
  if (new Set(seatNumbers).size !== seatNumbers.length) {
    throw createError({ statusCode: 400, statusMessage: 'Duplicate seat numbers are not allowed' })
  }
  const outOfRange = seatNumbers.filter(
    (seatNumber) => seatNumber < 1 || seatNumber > facility.totalSeats
  )
  if (outOfRange.length > 0) {
    throw createError({
      statusCode: 400,
      statusMessage: `Seat numbers must be between 1 and ${facility.totalSeats}`
    })
  }

  const certifiedSeats = seats.filter((seat) => seat.properties.length > 0)

  await prisma.$transaction(async (tx) => {
    await tx.cbtfSeat.deleteMany({ where: { facilityId } })
    if (certifiedSeats.length > 0) {
      await tx.cbtfSeat.createMany({
        data: certifiedSeats.map((seat) => ({
          facilityId,
          seatNumber: seat.seatNumber,
          properties: seat.properties
        }))
      })
    }
  })

  const storedSeats = new Map(certifiedSeats.map((seat) => [seat.seatNumber, seat.properties]))

  return {
    statusCode: 200,
    data: {
      facilityId: facility.id,
      facilityName: facility.name,
      totalSeats: facility.totalSeats,
      seats: Array.from({ length: facility.totalSeats }, (_, index) => ({
        seatNumber: index + 1,
        properties: storedSeats.get(index + 1) ?? []
      }))
    }
  }
})
