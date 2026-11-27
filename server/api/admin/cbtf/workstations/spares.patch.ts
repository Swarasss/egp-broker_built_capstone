import { defineEventHandler, readBody, createError } from 'h3'
import prisma from '@@/server/utils/db'
import { cbtfSpareSeatConfigInputSchema } from '@@/shared/schemas/cbtf.schema'
import { configureSpareSeats } from '@@/server/utils/cbtf-workstations'
import type { ApiResponse } from '@@/shared/types/api'

/** Admin-only: set or reset the number of spare seats for a facility. */
export default defineEventHandler(async (event): Promise<ApiResponse<any>> => {
  const session = await getUserSession(event)
  if (!session?.user) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  if (session.user.globalRole !== 'ADMIN') {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }

  const body = await readBody(event)
  const validation = cbtfSpareSeatConfigInputSchema.safeParse(body)
  if (!validation.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Invalid spare seat configuration',
      data: validation.error.flatten()
    })
  }

  const result = await prisma.$transaction((tx) =>
    configureSpareSeats(tx as any, {
      facilityId: validation.data.facilityId,
      spareSeatCount: validation.data.spareSeatCount,
      reset: validation.data.reset
    })
  )

  return { statusCode: 200, data: result }
})
