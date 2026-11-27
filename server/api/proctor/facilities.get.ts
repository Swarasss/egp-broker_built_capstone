import { defineEventHandler, createError } from 'h3'
import prisma from '@@/server/utils/db'
import type { ApiResponse } from '@@/shared/types/api'
import type { CbtfFacility } from '@@/shared/models/cbtf'

type ProctorFacility = Pick<CbtfFacility, 'id' | 'name' | 'timezone' | 'totalSeats'>

export default defineEventHandler(async (event): Promise<ApiResponse<ProctorFacility[]>> => {
  const session = await getUserSession(event)
  if (!session?.user) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  const role = session.user.globalRole
  if (role !== 'PROCTOR' && role !== 'ADMIN') {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  const facilities = await prisma.cbtfFacility.findMany({
    select: { id: true, name: true, timezone: true, totalSeats: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }]
  })

  return { statusCode: 200, data: facilities }
})
