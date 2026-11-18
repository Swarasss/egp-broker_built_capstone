import { defineEventHandler, getRouterParam, createError } from 'h3'
import prisma from '@@/server/utils/db'
import type { ApiResponse } from '@@/shared/types/api'

/** Admin removal of a student's SSD accommodation profile. */
export default defineEventHandler(
  async (event): Promise<ApiResponse<{ userId: string; removed: boolean }>> => {
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

    const result = await prisma.cbtfStudentAccommodation.deleteMany({ where: { userId } })
    if (result.count === 0) {
      throw createError({ statusCode: 404, statusMessage: 'Accommodation not found' })
    }

    return {
      statusCode: 200,
      data: { userId, removed: true }
    }
  }
)
