import { defineEventHandler, getRouterParam, readBody, createError } from 'h3'
import prisma from '@@/server/utils/db'
import { toCbtfReservationDto, getStudentAccommodation } from '@@/server/utils/cbtf'
import { chooseCbtfPlacement, lockCbtfFacilities } from '@@/server/utils/cbtf-placement'
import {
  syncCbtfReservationCanvasOverride,
  deleteCbtfReservationCanvasOverride
} from '@@/server/utils/cbtf-canvas'
import { cbtfAdminUpdateReservationSchema } from '@@/shared/schemas/cbtf.schema'
import type { ApiResponse } from '@@/shared/types/api'
import type { CbtfReservationDto } from '@@/shared/models/cbtf'

export default defineEventHandler(async (event): Promise<ApiResponse<CbtfReservationDto>> => {
  const session = await getUserSession(event)
  if (!session?.user) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  if (session.user.globalRole !== 'ADMIN') {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  const adminUserId = session.user.id

  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: 'ID is required' })
  }

  const rawBody = await readBody(event)
  const body = cbtfAdminUpdateReservationSchema.parse(rawBody)

  const updated = await prisma.$transaction(
    async (tx) => {
      await lockCbtfFacilities(tx)

      const existing = await tx.cbtfReservation.findUnique({
        where: { id }
      })

      if (!existing) {
        throw createError({
          statusCode: 404,
          statusMessage: 'Reservation not found'
        })
      }

      const startTime = body.startTime ? new Date(body.startTime) : existing.startTime

      const endTime = body.endTime ? new Date(body.endTime) : existing.endTime

      const seatNumber = body.seatNumber ?? existing.seatNumber
      const status = body.status ?? existing.status

      const isActive = status === 'SCHEDULED' || status === 'CHECKED_IN'

      const wasActive = existing.status === 'SCHEDULED' || existing.status === 'CHECKED_IN'

      const placementChanged =
        seatNumber !== existing.seatNumber ||
        +startTime !== +existing.startTime ||
        +endTime !== +existing.endTime

      if ((placementChanged || (isActive && !wasActive)) && endTime <= startTime) {
        throw createError({
          statusCode: 400,
          statusMessage: 'End time must be after start time'
        })
      }

      if (isActive && (placementChanged || !wasActive)) {
        const overlappingReservation = await tx.cbtfReservation.findFirst({
          where: {
            userId: existing.userId,
            id: { not: existing.id },
            status: { in: ['SCHEDULED', 'CHECKED_IN'] },
            startTime: { lt: endTime },
            endTime: { gt: startTime }
          }
        })

        if (overlappingReservation) {
          throw createError({
            statusCode: 409,
            statusMessage: 'Student has an overlapping reservation'
          })
        }

        const accommodation = await getStudentAccommodation(existing.userId, tx)

        await chooseCbtfPlacement(
          tx,
          [existing.facilityId],
          startTime,
          endTime,
          accommodation.requiredSeatProperties,
          existing.id,
          seatNumber
        )
      }

      const data: Record<string, any> = {}

      if (body.status) {
        data.status = body.status

        if (body.status === 'CHECKED_OUT' && !existing.checkedOutAt) {
          data.checkedOutAt = new Date()
          data.checkedOutByUserId = adminUserId
        } else if (body.status === 'CHECKED_IN' && !existing.checkedInAt) {
          data.checkedInAt = new Date()
          data.checkedInByUserId = adminUserId
        }
      }

      if (body.seatNumber !== undefined) {
        data.seatNumber = body.seatNumber
      }

      if (body.startTime) {
        data.startTime = startTime
      }

      if (body.endTime) {
        data.endTime = endTime
      }

      try {
        return await tx.cbtfReservation.update({
          where: {
            id,
            status: existing.status,
            facilityId: existing.facilityId,
            seatNumber: existing.seatNumber
          },
          data,
          include: {
            assignment: { select: { title: true } },
            user: {
              select: {
                firstName: true,
                lastName: true,
                email: true,
                studentId: true,
                avatarUrl: true
              }
            }
          }
        })
      } catch (error) {
        if ((error as { code?: string })?.code === 'P2025') {
          throw createError({
            statusCode: 409,
            statusMessage: 'Reservation changed. Please refresh and try again.'
          })
        }
        throw error
      }
    },
    { isolationLevel: 'ReadCommitted' }
  )

  // Synchronize Canvas only after the transaction succeeds.
  if (body.status === 'CANCELLED') {
    await deleteCbtfReservationCanvasOverride(id)
  } else if (body.startTime || body.endTime || body.status === 'SCHEDULED') {
    await syncCbtfReservationCanvasOverride(id)
  }

  return {
    statusCode: 200,
    data: toCbtfReservationDto(updated)
  }
})
