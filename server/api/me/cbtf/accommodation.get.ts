import { defineEventHandler, createError } from 'h3'
import { getStudentAccommodation } from '@@/server/utils/cbtf'
import type { ApiResponse } from '@@/shared/types/api'
import type { StudentAccommodationSnapshot } from '@@/server/utils/cbtf'

/**
 * Returns the signed-in student's effective SSD accommodation.
 * Students can view it (to understand extra time and seat requirements)
 * but only test-center staff can change it.
 */
export default defineEventHandler(
  async (event): Promise<ApiResponse<StudentAccommodationSnapshot>> => {
    const session = await getUserSession(event)
    if (!session?.user?.id) {
      throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
    }

    const accommodation = await getStudentAccommodation(session.user.id)

    return {
      statusCode: 200,
      data: accommodation
    }
  }
)
