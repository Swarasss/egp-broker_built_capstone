import { defineEventHandler, getRouterParam, readBody, createError } from 'h3'
import prisma from '@@/server/utils/db'
import { rescheduleReservationInputSchema } from '@@/shared/schemas/cbtf.schema'
import {
  getStudentAccommodation,
  getEffectiveExamDurationMinutes,
  getStudentSchedulingWindow,
  assertCbtfReservationWindowOpen,
  toCbtfReservationDto
} from '@@/server/utils/cbtf'
import { chooseCbtfPlacement, lockCbtfFacilities } from '@@/server/utils/cbtf-placement'
import { syncCbtfReservationCanvasOverride } from '@@/server/utils/cbtf-canvas'
import { notifyCbtfScheduleFailure } from '@@/server/services/alert.service'
import type { ApiResponse } from '@@/shared/types/api'
import type { CbtfReservationDto } from '@@/shared/models/cbtf'

export default defineEventHandler(async (event): Promise<ApiResponse<CbtfReservationDto>> => {
  const session = await getUserSession(event)
  if (!session?.user?.id) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  const studentInfo = {
    studentName: session.user.firstName
      ? `${session.user.firstName} ${session.user.lastName || ''}`.trim()
      : null,
    studentEmail: session.user.email || null,
    studentId: session.user.studentId || null
  }
  let currentStep = 'Initial Request Parsing'
  let targetSlot: string | null = null
  let targetAssignmentTitle: string | null = null
  let targetCourseLabel: string | null = null

  try {
    const reservationId = getRouterParam(event, 'id')
    if (!reservationId) {
      throw createError({ statusCode: 400, statusMessage: 'Reservation ID is required' })
    }

    const body = await readBody(event)
    if (body?.startTime && typeof body.startTime === 'string') {
      targetSlot = body.startTime
    }

    currentStep = 'Validating Input Schema'
    const validation = rescheduleReservationInputSchema.safeParse(body)
    if (!validation.success) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Invalid reschedule request',
        data: validation.error.flatten()
      })
    }
    const { startTime: newStartTimeStr } = validation.data
    targetSlot = newStartTimeStr

    currentStep = 'Checking 5-Minute Boundary Alignment'
    const newStartTime = new Date(newStartTimeStr)
    if (isNaN(newStartTime.getTime())) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid start time format' })
    }

    if (
      newStartTime.getUTCMinutes() % 5 !== 0 ||
      newStartTime.getUTCSeconds() !== 0 ||
      newStartTime.getUTCMilliseconds() !== 0
    ) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Reservation must align with a 5-minute boundary'
      })
    }

    // Ensure new time is in the future
    currentStep = 'Verifying Slot Is In The Future'
    if (newStartTime < new Date()) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Cannot reschedule to a time slot in the past'
      })
    }

    const updatedReservation = await prisma.$transaction(async (tx) => {
      currentStep = 'Locking Testing Facilities'
      const facilityIds = await lockCbtfFacilities(tx)

      currentStep = 'Retrieving Existing Reservation'
      const existing = await tx.cbtfReservation.findUnique({
        where: { id: reservationId },
        include: {
          assignment: {
            include: {
              course: { select: { label: true, title: true } }
            }
          }
        }
      })

      if (!existing || existing.userId !== session.user.id) {
        throw createError({ statusCode: 404, statusMessage: 'Reservation not found' })
      }
      currentStep = 'Checking Reservation Window'
      assertCbtfReservationWindowOpen(existing.assignment)
      currentStep = 'Applying SSD Accommodations'
      const accommodation = await getStudentAccommodation(session.user.id, tx)
      const durationMinutes = getEffectiveExamDurationMinutes(
        existing.assignment.cbtfDurationMinutes,
        accommodation.timeMultiplier
      )
      const newEndTime = new Date(newStartTime.getTime() + durationMinutes * 60 * 1000)
      targetAssignmentTitle = existing.assignment?.title || null
      targetCourseLabel =
        existing.assignment?.course?.label || existing.assignment?.course?.title || null

      currentStep = 'Verifying Reservation Status'
      if (
        existing.status !== 'SCHEDULED' &&
        existing.status !== 'MISSED' &&
        existing.status !== 'CANCELLED'
      ) {
        throw createError({
          statusCode: 400,
          statusMessage: `Cannot reschedule reservation in ${existing.status} status`
        })
      }

      // Prevent duplicate: student cannot have another active reservation for the same assignment
      currentStep = 'Checking For Duplicate Assignment Reservation'
      const existingActiveForAssignment = await tx.cbtfReservation.findFirst({
        where: {
          userId: session.user.id,
          assignmentId: existing.assignment?.id || existing.assignmentId,
          id: { not: existing.id },
          status: { in: ['SCHEDULED', 'CHECKED_IN'] }
        }
      })
      if (existingActiveForAssignment) {
        throw createError({
          statusCode: 409,
          statusMessage:
            'You already have an active reservation for this assignment. Cancel it before rescheduling this one.'
        })
      }

      // Check if student already completed this exam (requires retake pass to reschedule)
      currentStep = 'Checking For Completed Exam'
      const existingCompleted = await tx.cbtfReservation.findFirst({
        where: {
          userId: session.user.id,
          assignmentId: existing.assignment?.id || existing.assignmentId,
          id: { not: existing.id },
          status: { in: ['CHECKED_OUT', 'COMPLETED'] }
        }
      })
      if (existingCompleted) {
        const studentWindow = await getStudentSchedulingWindow(session.user.id, existing.assignment, tx)
        if (!studentWindow.isPassWindow) {
          throw createError({
            statusCode: 403,
            statusMessage:
              'You have already completed this exam. A retake pass is required to reschedule another attempt.'
          })
        }
      }

      // Check for time collision with student's other active reservations
      currentStep = 'Checking Time Overlap With Other Reservations'
      const conflictingSlot = await tx.cbtfReservation.findFirst({
        where: {
          userId: session.user.id,
          id: { not: existing.id },
          status: { in: ['SCHEDULED', 'CHECKED_IN'] },
          startTime: { lt: newEndTime },
          endTime: { gt: newStartTime }
        },
        include: {
          assignment: { select: { title: true } }
        }
      })
      if (conflictingSlot) {
        throw createError({
          statusCode: 409,
          statusMessage: `You already have an active test reservation for "${conflictingSlot.assignment?.title || 'another assignment'}" overlapping this time slot`
        })
      }

      // Verify within student scheduling window
      currentStep = 'Verifying Student Availability Window'
      const studentWindow = await getStudentSchedulingWindow(session.user.id, existing.assignment, tx)
      if (newStartTime < studentWindow.start || newEndTime > studentWindow.end) {
        throw createError({
          statusCode: 400,
          statusMessage: 'Selected time slot falls outside your test availability window'
        })
      }

      currentStep = 'Selecting Testing Facility and Workstation'
      const { facility, seatNumber: assignedSeat } = await chooseCbtfPlacement(
        tx, facilityIds, newStartTime, newEndTime, accommodation.requiredSeatProperties, existing.id
      )

      const updated = await tx.cbtfReservation.update({
        where: { id: existing.id, status: existing.status },
        data: {
          facilityId: facility.id,
          startTime: newStartTime,
          endTime: newEndTime,
          seatNumber: assignedSeat,
          status: 'SCHEDULED'
        },
        include: {
          facility: { select: { name: true } },
          assignment: { select: { title: true } },
          user: { select: { firstName: true, lastName: true, studentId: true, avatarUrl: true } }
        }
      })

      return updated
    }, { isolationLevel: 'ReadCommitted' })

    currentStep = 'Syncing Canvas Override'
    // Synchronize individual Canvas assignment override (Option A: non-blocking)
    const syncResult = await syncCbtfReservationCanvasOverride(updatedReservation.id)
    if (syncResult.overrideId) {
      updatedReservation.canvasOverrideId = syncResult.overrideId
    }

    return {
      statusCode: 200,
      data: toCbtfReservationDto(updatedReservation)
    }
  } catch (err: any) {
    const errorType = err.statusCode
      ? `HTTP ${err.statusCode} (${err.name || 'H3Error'})`
      : err.name || 'Error'
    const errorMessage = err.statusMessage || err.message || 'Unknown error'
    const errorLocation = `server/api/me/cbtf/reservations/[id].patch.ts (${currentStep})`

    await notifyCbtfScheduleFailure({
      studentName: studentInfo.studentName,
      studentEmail: studentInfo.studentEmail,
      studentId: studentInfo.studentId,
      assignmentTitle: targetAssignmentTitle,
      courseLabel: targetCourseLabel,
      timeSlot: targetSlot,
      errorType,
      errorMessage,
      errorLocation,
      isReschedule: true
    }).catch((alertErr) =>
      console.warn('[CBTF Alert] Failed to dispatch reschedule failure alert:', alertErr)
    )

    throw err
  }
})
