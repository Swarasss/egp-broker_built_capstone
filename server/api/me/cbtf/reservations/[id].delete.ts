import { defineEventHandler, getRouterParam, createError } from 'h3'
import prisma from '@@/server/utils/db'
import { toCbtfReservationDto } from '@@/server/utils/cbtf'
import { deleteCbtfReservationCanvasOverride } from '@@/server/utils/cbtf-canvas'
import type { ApiResponse } from '@@/shared/types/api'
import type { CbtfReservationDto } from '@@/shared/models/cbtf'

export default defineEventHandler(async (event): Promise<ApiResponse<CbtfReservationDto>> => {
  const session = await getUserSession(event)
  if (!session?.user?.id) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  const reservationId = getRouterParam(event, 'id')
  if (!reservationId) {
    throw createError({ statusCode: 400, statusMessage: 'Reservation ID is required' })
  }

  const existing = await prisma.cbtfReservation.findUnique({
    where: { id: reservationId },
    include: {
      assignment: { select: { title: true } },
      user: { select: { firstName: true, lastName: true, studentId: true, avatarUrl: true } }
    }
  })

  if (!existing || existing.userId !== session.user.id) {
    throw createError({ statusCode: 404, statusMessage: 'Reservation not found' })
  }

  if (existing.status !== 'SCHEDULED') {
    throw createError({
      statusCode: 400,
      statusMessage: `Only scheduled reservations can be cancelled. Current status is ${existing.status}`
    })
  }

  // Delete individual Canvas assignment override if present;
  // failure must not block local cancellation (seat still freed)
  try {
    await deleteCbtfReservationCanvasOverride(existing.id)
  } catch {
    console.warn(`[CBTF Cancel] Failed to delete Canvas override for reservation ${existing.id}`)
  }

  // Atomically transition SCHEDULED -> CANCELLED only if still SCHEDULED
  // (prevents cancelling a reservation a proctor already checked in)
  let updated: any
  try {
    updated = await prisma.cbtfReservation.update({
      where: { id: existing.id, status: 'SCHEDULED' },
      data: { status: 'CANCELLED' },
      include: {
        assignment: { select: { title: true } },
        user: { select: { firstName: true, lastName: true, studentId: true, avatarUrl: true } }
      }
    })
  } catch (err: any) {
    if (err?.code === 'P2025') {
      throw createError({
        statusCode: 409,
        statusMessage: 'Reservation is no longer available to cancel'
      })
    }
    throw err
  }

  return {
    statusCode: 200,
    data: toCbtfReservationDto(updated)
  }
})
