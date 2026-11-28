import { defineEventHandler, readBody, createError } from 'h3'
import prisma from '@@/server/utils/db'
import { createReservationInputSchema } from '@@/shared/schemas/cbtf.schema'
import {
  getStudentAccommodation,
  getEffectiveExamDurationMinutes,
  getCbtfSchedulingState,
  assertCbtfSchedulingOpen,
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
    const body = await readBody(event)
    if (body?.startTime && typeof body.startTime === 'string') {
      targetSlot = body.startTime
    }

    currentStep = 'Validating Input Schema'
    const validation = createReservationInputSchema.safeParse(body)
    if (!validation.success) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Invalid reservation request',
        data: validation.error.flatten()
      })
    }
    const { assignmentId, startTime: startTimeStr } = validation.data
    targetSlot = startTimeStr

    currentStep = 'Checking 5-Minute Boundary Alignment'
    const startTime = new Date(startTimeStr)
    if (isNaN(startTime.getTime())) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid start time format' })
    }

    // 1. Enforce 5-minute boundary alignment
    if (
      startTime.getUTCMinutes() % 5 !== 0 ||
      startTime.getUTCSeconds() !== 0 ||
      startTime.getUTCMilliseconds() !== 0
    ) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Reservation must align with a 5-minute boundary (e.g. :00, :05, :10)'
      })
    }

    // 2b. Ensure reservation is in the future
    currentStep = 'Verifying Slot Is In The Future'
    if (startTime < new Date()) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Cannot schedule a reservation in the past'
      })
    }

    // 3. Verify assignment exists and is schedulable
    const newReservation = await prisma.$transaction(async (tx) => {
      currentStep = 'Locking Testing Facilities'
      const facilityIds = await lockCbtfFacilities(tx)

      currentStep = 'Verifying Assignment Schedulability'
      const assignment = await tx.assignment.findUnique({
        where: { id: assignmentId },
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
          acceptUntil: true,
          course: { select: { label: true, title: true } }
        }
      })

      if (!assignment || !assignment.isSchedulable) {
        throw createError({
          statusCode: 400,
          statusMessage: 'Assignment is not configured for CBTF scheduling'
        })
      }
      currentStep = 'Applying SSD Accommodations'
      const accommodation = await getStudentAccommodation(session.user.id, tx)
      const durationMinutes = getEffectiveExamDurationMinutes(
        assignment.cbtfDurationMinutes,
        accommodation.timeMultiplier
      )
      const endTime = new Date(startTime.getTime() + durationMinutes * 60 * 1000)
      targetAssignmentTitle = assignment.title
      targetCourseLabel = assignment.course?.label || assignment.course?.title || null

      // 4. Verify enrollment
      currentStep = 'Verifying Course Enrollment'
      const enrollment = await tx.enrollment.findFirst({
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

      // 5. Prevent double booking: student cannot have active reservation for this assignment
      currentStep = 'Checking For Double Booking'
      const existingActive = await tx.cbtfReservation.findFirst({
        where: {
          userId: session.user.id,
          assignmentId,
          status: { in: ['SCHEDULED', 'CHECKED_IN'] }
        }
      })
      if (existingActive) {
        throw createError({
          statusCode: 409,
          statusMessage:
            'You already have an active reservation for this assignment. Please reschedule or cancel it.'
        })
      }

      // 5b. Prevent time collision: student cannot have another active reservation overlapping this time slot
      currentStep = 'Checking Time Overlap With Other Reservations'
      const conflictingSlot = await tx.cbtfReservation.findFirst({
        where: {
          userId: session.user.id,
          status: { in: ['SCHEDULED', 'CHECKED_IN'] },
          startTime: { lt: endTime },
          endTime: { gt: startTime }
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

      currentStep = 'Verifying Student Availability Window'
      const scheduling = await getCbtfSchedulingState(
        session.user.id, assignment, tx, null, new Date(), durationMinutes
      )
      assertCbtfSchedulingOpen(scheduling)
      const studentWindow = scheduling.examWindow

      if (startTime < studentWindow.start || endTime > studentWindow.end) {
        throw createError({
          statusCode: 400,
          statusMessage: `Selected slot falls outside your test availability window (${studentWindow.start.toISOString()} to ${studentWindow.end.toISOString()})`
        })
      }

      // Check if there is an uncompleted reservation (CANCELLED or MISSED) that can be reused
      const reusableId = scheduling.reusableRetakeId ?? scheduling.normalMissedId
      const reusableReservation = await tx.cbtfReservation.findFirst({
        where: {
          userId: session.user.id,
          assignmentId,
          status: { in: ['CANCELLED', 'MISSED'] },
          retakeRedemptionId: scheduling.reusableRetakeId ? studentWindow.redemptionId : null,
          ...(reusableId ? { id: reusableId } : {})
        },
        orderBy: { updatedAt: 'desc' }
      })

      if (reusableId && !reusableReservation) {
        throw createError({
          statusCode: 409,
          statusMessage: scheduling.reusableRetakeId
            ? 'The retake reservation changed. Refresh and try again.'
            : 'The missed reservation changed. Refresh and try again.'
        })
      }

      currentStep = 'Selecting Testing Facility and Workstation'
      const { facility, seatNumber: assignedSeat } = await chooseCbtfPlacement(
        tx, facilityIds, startTime, endTime, accommodation.requiredSeatProperties
      )

      // E. Create or reuse reservation
      let created: any
      if (reusableReservation) {
        created = await tx.cbtfReservation.update({
          where: {
            id: reusableReservation.id,
            status: reusableReservation.status,
            AND: [{ retakeRedemptionId: reusableReservation.retakeRedemptionId }]
          },
          data: {
            facilityId: facility.id,
            seatNumber: assignedSeat,
            startTime,
            endTime,
            status: 'SCHEDULED',
            retakeRedemptionId: studentWindow.redemptionId
          },
          include: {
            facility: { select: { name: true } },
            assignment: { select: { title: true } },
            user: { select: { firstName: true, lastName: true, studentId: true, avatarUrl: true } }
          }
        })
      } else {
        created = await tx.cbtfReservation.create({
          data: {
            facilityId: facility.id,
            assignmentId,
            userId: session.user.id,
            seatNumber: assignedSeat,
            startTime,
            endTime,
            status: 'SCHEDULED',
            retakeRedemptionId: studentWindow.redemptionId
          },
          include: {
            facility: { select: { name: true } },
            assignment: { select: { title: true } },
            user: { select: { firstName: true, lastName: true, studentId: true, avatarUrl: true } }
          }
        })
      }

      return created
    }, { isolationLevel: 'ReadCommitted' })

    currentStep = 'Syncing Canvas Override'
    // Synchronize individual Canvas assignment override (Option A: non-blocking)
    const syncResult = await syncCbtfReservationCanvasOverride(newReservation.id)
    if (syncResult.overrideId) {
      newReservation.canvasOverrideId = syncResult.overrideId
    }

    return {
      statusCode: 201,
      data: toCbtfReservationDto(newReservation)
    }
  } catch (err: any) {
    if (err.code === 'P2002' && err.meta?.target?.includes('retakeRedemptionId')) {
      throw createError({ statusCode: 409, statusMessage: 'This pass has already been claimed for a retake.' })
    }
    if (err.code === 'P2025') {
      throw createError({ statusCode: 409, statusMessage: 'The reservation changed. Refresh and try again.' })
    }
    const errorType = err.statusCode
      ? `HTTP ${err.statusCode} (${err.name || 'H3Error'})`
      : err.name || 'Error'
    const errorMessage = err.statusMessage || err.message || 'Unknown error'
    const errorLocation = `server/api/me/cbtf/reservations.post.ts (${currentStep})`

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
      isReschedule: false
    }).catch((alertErr) =>
      console.warn('[CBTF Alert] Failed to dispatch schedule failure alert:', alertErr)
    )

    throw err
  }
})
