import { createError, defineEventHandler, getRouterParam, readValidatedBody } from 'h3'
import prisma from '@@/server/utils/db'
import type { ApiResponse } from '@@/shared/types/api'
import { updateAssignmentSchema } from '@@/shared/models/assignment'
import { getAssignmentSchedulingErrors } from '@@/shared/utils/assignment-scheduling'

export default defineEventHandler(async (event): Promise<ApiResponse<any>> => {
  const session = await getUserSession(event)

  if (!session.user || session.user.globalRole !== 'ADMIN') {
    throw createError({
      statusCode: 403,
      statusMessage: 'Forbidden'
    })
  }

  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing assignment ID'
    })
  }

  const body = await readValidatedBody(event, updateAssignmentSchema.parse)

  const existing = await prisma.assignment.findUnique({ where: { id } })
  if (!existing) throw createError({ statusCode: 404, statusMessage: 'Assignment not found' })
  const schedulingErrors = getAssignmentSchedulingErrors({
    ...existing,
    ...Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined))
  })
  if (schedulingErrors.length) {
    throw createError({ statusCode: 400, statusMessage: schedulingErrors[0]!.message, data: schedulingErrors })
  }

  const assignment = await prisma.assignment.update({
    where: { id },
    data: {
      title: body.title,
      canvasAssignmentId: body.canvasAssignmentId,
      dueDate: body.dueDate ? new Date(body.dueDate) : body.dueDate === null ? null : undefined,
      availableFrom: body.availableFrom
        ? new Date(body.availableFrom)
        : body.availableFrom === null
          ? null
          : undefined,
      acceptUntil: body.acceptUntil
        ? new Date(body.acceptUntil)
        : body.acceptUntil === null
          ? null
          : undefined,
      isSchedulable: body.isSchedulable,
      cbtfDurationMinutes: body.cbtfDurationMinutes,
      scheduleWindowStart: body.scheduleWindowStart ? new Date(body.scheduleWindowStart) : body.scheduleWindowStart,
      scheduleWindowEnd: body.scheduleWindowEnd ? new Date(body.scheduleWindowEnd) : body.scheduleWindowEnd,
      published: body.published !== undefined ? body.published : undefined
    }
  })

  // Sync automatic pass eligibility
  if (body.title) {
    await syncAssignmentEligibility(assignment.id)
  }

  return {
    statusCode: 200,
    data: assignment
  }
})
