import { defineEventHandler, getQuery, createError } from 'h3'
import prisma from '@@/server/utils/db'
import { cbtfAvailabilityQuerySchema } from '@@/shared/schemas/cbtf.schema'
import {
  getStudentSchedulingWindow,
  getAllFacilitiesAvailability,
  getStudentAccommodation,
  getEffectiveExamDurationMinutes,
  toCbtfReservationDto
} from '@@/server/utils/cbtf'
import type { ApiResponse } from '@@/shared/types/api'
import type {
  CbtfHalfDayBlock,
  CbtfRecommendedDay,
  CbtfHourlySlotChoice,
  CbtfReservationDto
} from '@@/shared/models/cbtf'

export interface CbtfAvailabilityResponse {
  assignmentTitle: string | null
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
  blocks: CbtfHalfDayBlock[]
  recommendedDays: CbtfRecommendedDay[]
  hourlySlots: CbtfHourlySlotChoice[]
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
      statusMessage: 'Assignment is not configured for CBTF scheduling'
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

  const { blocks, recommendedDays, hourlySlots } = await getAllFacilitiesAvailability(
    studentWindow,
    query.blockId || query.timeOfDayPreference,
    query.selectedDate,
    undefined,
    effectiveDurationMinutes,
    query.excludeReservationId,
    accommodation.requiredSeatProperties
  )

  return {
    statusCode: 200,
    data: {
      assignmentTitle: assignment.title,
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
      activeReservation: activeReservation ? toCbtfReservationDto(activeReservation) : null,
      blocks,
      recommendedDays,
      hourlySlots
    }
  }
})
