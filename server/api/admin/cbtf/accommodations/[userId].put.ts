import { defineEventHandler, getRouterParam, readBody, createError } from 'h3'
import prisma from '@@/server/utils/db'
import { cbtfAccommodationInputSchema } from '@@/shared/schemas/cbtf.schema'
import type { ApiResponse } from '@@/shared/types/api'
import type { CbtfAccommodationDto } from '@@/shared/models/cbtf'

/** Admin upsert of one student's SSD accommodation profile. */
export default defineEventHandler(
  async (event): Promise<ApiResponse<CbtfAccommodationDto>> => {
    const session = await getUserSession(event)
    if (!session?.user) {
      throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
    }
    if (session.user.globalRole !== 'ADMIN') {
      throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
    }

    const userId = getRouterParam(event, 'userId')
    if (!userId) {
      throw createError({ statusCode: 400, statusMessage: 'User ID is required' })
    }

    const body = await readBody(event)
    const validation = cbtfAccommodationInputSchema.safeParse(body)
    if (!validation.success) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Invalid accommodation data',
        data: validation.error.flatten()
      })
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, firstName: true, lastName: true, email: true, studentId: true }
    })
    if (!user) {
      throw createError({ statusCode: 404, statusMessage: 'Student not found' })
    }

    const { timeMultiplier, requiredSeatProperties, notes } = validation.data

    const accommodation = await prisma.cbtfStudentAccommodation.upsert({
      where: { userId },
      create: {
        userId,
        timeMultiplier,
        requiredSeatProperties,
        notes: notes ?? null,
        isActive: true,
        updatedById: session.user.id
      },
      update: {
        timeMultiplier,
        requiredSeatProperties,
        notes: notes ?? null,
        isActive: true,
        updatedById: session.user.id
      }
    })

    return {
      statusCode: 200,
      data: {
        userId: accommodation.userId,
        studentName: `${user.firstName} ${user.lastName}`.trim(),
        studentEmail: user.email,
        studentId: user.studentId,
        requiredSeatProperties: accommodation.requiredSeatProperties,
        timeMultiplier: accommodation.timeMultiplier,
        isActive: accommodation.isActive,
        notes: accommodation.notes,
        updatedAt: accommodation.updatedAt.toISOString()
      }
    }
  }
)
