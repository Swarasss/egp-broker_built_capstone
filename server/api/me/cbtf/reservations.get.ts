import { defineEventHandler, createError } from 'h3'
import prisma from '@@/server/utils/db'
import {
  applySeatOutOfServiceFlags,
  getCbtfMissedRecoveryWindow,
  getEffectiveExamDurationMinutes,
  getStudentAccommodation,
  toCbtfReservationDto
} from '@@/server/utils/cbtf'
import { isAllowedCbtfDuration } from '@@/shared/utils/assignment-scheduling'
import type { ApiResponse } from '@@/shared/types/api'
import type { CbtfReservationDto } from '@@/shared/models/cbtf'

export default defineEventHandler(async (event): Promise<ApiResponse<CbtfReservationDto[]>> => {
  const session = await getUserSession(event)
  if (!session?.user?.id) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  const reservations = await prisma.cbtfReservation.findMany({
    where: { userId: session.user.id },
    include: {
      assignment: {
        select: {
          title: true,
          isSchedulable: true,
          scheduleWindowStart: true,
          scheduleWindowEnd: true,
          availableFrom: true,
          acceptUntil: true,
          cbtfDurationMinutes: true
        }
      },
      facility: { select: { name: true } },
      user: { select: { firstName: true, lastName: true, studentId: true, avatarUrl: true } }
    },
    orderBy: { startTime: 'desc' }
  })

  const completedAssignments = new Set(
    reservations
      .filter(({ status }) => status === 'COMPLETED' || status === 'CHECKED_OUT')
      .map(({ assignmentId }) => assignmentId)
  )
  const canRecover = (reservation: (typeof reservations)[number]) =>
    reservation.status === 'MISSED' &&
    !reservation.retakeRedemptionId &&
    reservation.assignment.isSchedulable &&
    isAllowedCbtfDuration(reservation.assignment.cbtfDurationMinutes ?? 60) &&
    !completedAssignments.has(reservation.assignmentId)
  const accommodation = reservations.some(canRecover)
    ? await getStudentAccommodation(session.user.id)
    : null

  const data = reservations.map((reservation): CbtfReservationDto => {
    const missedRecoveryWindow = accommodation && canRecover(reservation)
      ? getCbtfMissedRecoveryWindow(
          reservation.assignment,
          getEffectiveExamDurationMinutes(
            reservation.assignment.cbtfDurationMinutes,
            accommodation.timeMultiplier
          )
        )
      : null
    return {
      ...toCbtfReservationDto(reservation),
      ...(reservation.retakeRedemptionId ? { isRetake: true } : {}),
      ...(missedRecoveryWindow ? {
        missedRecoveryWindow: {
          start: missedRecoveryWindow.start.toISOString(),
          end: missedRecoveryWindow.end.toISOString()
        }
      } : {})
    }
  })
  await applySeatOutOfServiceFlags(prisma, data)

  return {
    statusCode: 200,
    data
  }
})
