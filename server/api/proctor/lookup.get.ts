import { defineEventHandler, getQuery, createError } from 'h3'
import prisma from '@@/server/utils/db'
import { applySeatOutOfServiceFlags, lookupStudentForProctor } from '@@/server/utils/cbtf'
import type { ApiResponse } from '@@/shared/types/api'

export default defineEventHandler(async (event): Promise<ApiResponse<any>> => {
  const session = await getUserSession(event)
  if (!session?.user) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  const role = session.user.globalRole
  if (role !== 'PROCTOR' && role !== 'ADMIN') {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  const query = getQuery(event)
  const studentId = typeof query.studentId === 'string' ? query.studentId : ''

  if (!studentId.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'Student ID query parameter is required' })
  }

  const result = await lookupStudentForProctor(prisma as any, studentId)
  if (result?.reservation) {
    await applySeatOutOfServiceFlags(prisma, [result.reservation as any])
  }

  return {
    statusCode: 200,
    data: result
  }
})
