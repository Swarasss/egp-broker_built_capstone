import { defineEventHandler, getQuery, createError } from 'h3'
import prisma from '@@/server/utils/db'
import { cbtfAvailabilityQuerySchema } from '@@/shared/schemas/cbtf.schema'
import {
  getStudentSchedulingWindow,
  getCbtfReservationWindowStatus,
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
  if (query.excludeReservationId) {
    const reschedulingReservation = await prisma.cbtfReservation.findFirst({
      where: {
        id: query.excludeReservationId,
        userId: session.user.id,
        assignmentId: assignment.id,
        status: { in: ['SCHEDULED', 'MISSED', 'CANCELLED'] }
      },
      select: { id: true }
    })
    if (!reschedulingReservation) {
      throw createError({ statusCode: 404, statusMessage: 'Reschedulable reservation not found' })
    }
  }

  const studentWindow = await getStudentSchedulingWindow(session.user.id, assignment)
  const accommodation = await getStudentAccommodation(session.user.id)
  const effectiveDurationMinutes = getEffectiveExamDurationMinutes(
    assignment.cbtfDurationMinutes,
    accommodation.timeMultiplier
  )

  const now = new Date()
  const reservationWindowStatus = getCbtfReservationWindowStatus(assignment, now)
  const availability = reservationWindowStatus === 'OPEN'
    ? await getAllFacilitiesAvailability(
        studentWindow,
        query.blockId || query.timeOfDayPreference,
        query.selectedDate,
        undefined,
        effectiveDurationMinutes,
        query.excludeReservationId,
        accommodation.requiredSeatProperties,
        session.user.id,
        now
      )
    : {
        availabilityStatus: reservationWindowStatus === 'NOT_YET_OPEN' ? 'RESERVATION_NOT_OPEN' as const : 'RESERVATION_CLOSED' as const,
        facilityDiagnostics: [],
        configuredTotalSeats: null,
        blocks: [],
        recommendedDays: [],
        hourlySlots: []
      }

  return {
    statusCode: 200,
    data: {
      assignmentTitle: assignment.title,
      ...availability,
      reservationWindowStatus,
      reservationWindow: {
        start: assignment.scheduleWindowStart?.toISOString() ?? null,
        end: assignment.scheduleWindowEnd?.toISOString() ?? null
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
