import { defineEventHandler, getQuery, createError } from 'h3'
import prisma from '@@/server/utils/db'
import { cbtfAvailabilityQuerySchema } from '@@/shared/schemas/cbtf.schema'
import {
  getCbtfSchedulingState,
  getAllFacilitiesAvailability,
  getStudentAccommodation,
  getEffectiveExamDurationMinutes,
  toCbtfReservationDto
} from '@@/server/utils/cbtf'
import type { ApiResponse } from '@@/shared/types/api'
import type {
  CbtfAvailabilityStatus,
  CbtfFacilityAvailabilityDiagnostic,
  CbtfReservationWindow,
  CbtfStudentBlock,
  CbtfRecommendedDay,
  CbtfStudentStart,
  CbtfSchedulingChoices,
  CbtfReservationDto
} from '@@/shared/models/cbtf'

export interface CbtfAvailabilityResponse extends CbtfReservationWindow {
  availabilityStatus: CbtfAvailabilityStatus
  facilityDiagnostics: CbtfFacilityAvailabilityDiagnostic[]
  assignmentTitle: string | null
  configuredTotalSeats: number | null
  studentWindow: {
    start: string
    end: string
    isPassWindow: boolean
  }
  accommodation: {
    requiredSeatProperties: string[]
    timeMultiplier: number
    effectiveDurationMinutes: number
  }
  activeReservation: CbtfReservationDto | null
  blocks: CbtfStudentBlock[]
  recommendedDays: CbtfRecommendedDay[]
  hourlySlots: CbtfStudentStart[]
  schedulingChoices?: CbtfSchedulingChoices
}

export default defineEventHandler(async (event): Promise<ApiResponse<CbtfAvailabilityResponse>> => {
  const session = await getUserSession(event)
  if (!session?.user?.id) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  const rawQuery = getQuery(event)
  const queryResult = cbtfAvailabilityQuerySchema.safeParse(rawQuery)
  if (!queryResult.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid availability query',
      data: queryResult.error.flatten()
    })
  }
  const query = queryResult.data

  const assignment = await prisma.assignment.findUnique({
    where: { id: query.assignmentId },
    select: {
      id: true,
      courseId: true,
      title: true,
      isSchedulable: true,
      cbtfDurationMinutes: true,
      scheduleWindowStart: true,
      scheduleWindowEnd: true,
      availableFrom: true,
      dueDate: true,
      acceptUntil: true
    }
  })

  if (!assignment || !assignment.isSchedulable) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Assignment is not configured for CBTF scheduling',
      data: { availabilityStatus: 'INVALID_ASSIGNMENT_WINDOW' }
    })
  }

  const enrollment = await prisma.enrollment.findFirst({
    where: {
      userId: session.user.id,
      courseId: assignment.courseId
    }
  })

  if (!enrollment && session.user.globalRole === 'USER') {
    throw createError({
      statusCode: 403,
      statusMessage: 'You are not enrolled in this course'
    })
  }

  const activeReservation = await prisma.cbtfReservation.findFirst({
    where: {
      userId: session.user.id,
      assignmentId: assignment.id,
      status: { in: ['SCHEDULED', 'CHECKED_IN'] }
    },
    include: {
      assignment: { select: { title: true } },
      user: { select: { firstName: true, lastName: true, studentId: true, avatarUrl: true } }
    }
  })

  // Only an owned, reschedulable reservation for this assignment may be excluded.
  let reschedulingReservation = null
  if (query.excludeReservationId) {
    reschedulingReservation = await prisma.cbtfReservation.findFirst({
      where: {
        id: query.excludeReservationId,
        userId: session.user.id,
        assignmentId: assignment.id,
        status: { in: ['SCHEDULED', 'MISSED', 'CANCELLED'] }
      },
      select: { id: true, retakeRedemptionId: true }
    })
    if (!reschedulingReservation) {
      throw createError({ statusCode: 404, statusMessage: 'Reschedulable reservation not found' })
    }
  }

  const now = new Date()
  const scheduling = await getCbtfSchedulingState(
    session.user.id, assignment, prisma, reschedulingReservation, now
  )
  const { examWindow: studentWindow, actionStatus: reservationWindowStatus, actionWindow } = scheduling
  const accommodation = await getStudentAccommodation(session.user.id)
  const effectiveDurationMinutes = getEffectiveExamDurationMinutes(
    assignment.cbtfDurationMinutes,
    accommodation.timeMultiplier
  )

  const availability = !scheduling.retakeBlock && reservationWindowStatus === 'OPEN'
    ? await getAllFacilitiesAvailability(
        studentWindow,
        query.blockId || query.timeOfDayPreference,
        query.selectedDate,
        undefined,
        effectiveDurationMinutes,
        query.excludeReservationId,
        accommodation.requiredSeatProperties,
        session.user.id,
        now,
        query.view === 'narrowing' ? assignment.id : undefined
      )
    : {
        availabilityStatus: scheduling.retakeBlock ??
          (reservationWindowStatus === 'NOT_YET_OPEN' ? 'RESERVATION_NOT_OPEN' as const : 'RESERVATION_CLOSED' as const),
        facilityDiagnostics: [],
        configuredTotalSeats: null,
        blocks: [],
        recommendedDays: [],
        hourlySlots: [],
        ...(query.view === 'narrowing' ? { schedulingChoices: { morning: [], afternoon: [] } } : {})
      }

  return {
    statusCode: 200,
    data: {
      assignmentTitle: assignment.title,
      ...availability,
      reservationWindowStatus,
      reservationWindow: {
        start: actionWindow.scheduleWindowStart?.toISOString() ?? null,
        end: actionWindow.scheduleWindowEnd?.toISOString() ?? null
      },
      studentWindow: {
        start: studentWindow.start.toISOString(),
        end: studentWindow.end.toISOString(),
        isPassWindow: studentWindow.isPassWindow
      },
      accommodation: {
        requiredSeatProperties: accommodation.requiredSeatProperties,
        timeMultiplier: accommodation.timeMultiplier,
        effectiveDurationMinutes
      },
      activeReservation: activeReservation ? toCbtfReservationDto(activeReservation) : null
    }
  }
})
