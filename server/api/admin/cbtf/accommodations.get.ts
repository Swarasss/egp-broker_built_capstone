import { defineEventHandler, getQuery, createError } from 'h3'
import prisma from '@@/server/utils/db'
import { cbtfAccommodationSearchSchema } from '@@/shared/schemas/cbtf.schema'
import type { ApiResponse } from '@@/shared/types/api'
import type { CbtfAccommodationDto } from '@@/shared/models/cbtf'

/** Admin list of student SSD accommodations, searchable by name/email/student ID. */
export default defineEventHandler(
  async (event): Promise<ApiResponse<CbtfAccommodationDto[]>> => {
    const session = await getUserSession(event)
    if (!session?.user) {
      throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
    }
    if (session.user.globalRole !== 'ADMIN') {
      throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
    }

    const query = cbtfAccommodationSearchSchema.safeParse(getQuery(event))
    if (!query.success) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Invalid search query',
        data: query.error.flatten()
      })
    }
    const search = query.data.search

    const accommodations = await prisma.cbtfStudentAccommodation.findMany({
      where: search
        ? {
            user: {
              OR: [
                { firstName: { contains: search, mode: 'insensitive' } },
                { lastName: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
                { studentId: { contains: search, mode: 'insensitive' } }
              ]
            }
          }
        : undefined,
      include: {
        user: {
          select: { id: true, firstName: true, lastName: true, email: true, studentId: true }
        }
      },
      orderBy: { updatedAt: 'desc' },
      take: 200
    })

    return {
      statusCode: 200,
      data: accommodations.map((accommodation) => ({
        userId: accommodation.userId,
        studentName: `${accommodation.user.firstName} ${accommodation.user.lastName}`.trim(),
        studentEmail: accommodation.user.email,
        studentId: accommodation.user.studentId,
        requiredSeatProperties: accommodation.requiredSeatProperties,
        timeMultiplier: accommodation.timeMultiplier,
        isActive: accommodation.isActive,
        notes: accommodation.notes,
        updatedAt: accommodation.updatedAt.toISOString()
      }))
    }
  }
)
