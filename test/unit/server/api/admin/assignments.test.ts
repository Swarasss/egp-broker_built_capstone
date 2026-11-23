import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'
import assignmentDelete from '../../../../../server/api/admin/assignments/[id].delete'
import assignmentCreate from '../../../../../server/api/admin/assignments.post'
import prisma from '@@/server/utils/db'
import { deleteAssignment } from '../../../../../server/utils/assignments'

vi.mock('@@/server/utils/db', () => ({
  default: {
    assignment: {
      create: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn()
    },
    ltiResult: {
      deleteMany: vi.fn()
    },
    $transaction: vi.fn((cb) => cb(prisma))
  }
}))

vi.mock('../../../../../server/utils/assignments', () => ({
  deleteAssignment: vi.fn()
}))

vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('h3')>()
  return {
    ...actual,
    defineEventHandler: (handler: (event: any) => any) => handler,
    readValidatedBody: async (event: H3Event, parse: (body: unknown) => unknown) =>
      parse(event.context.body),
    getRouterParam: vi.fn((event, param) => event.params?.[param]),
    createError: (opts: any) => opts
  }
})

const mockEvent = (userRole: string | null = 'ADMIN', params: Record<string, string> = {}) =>
  ({
    context: {
      user: userRole ? { globalRole: userRole } : null
    },
    params
  }) as unknown as H3Event

vi.stubGlobal('getUserSession', (event: any) => Promise.resolve({ user: event.context.user }))
vi.stubGlobal('syncAssignmentEligibility', vi.fn())

describe('API: Admin Assignments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('persists validated CBTF scheduling fields when an admin creates an assignment', async () => {
    const event = mockEvent()
    event.context.body = {
      courseId: 'c1',
      isSchedulable: true,
      cbtfDurationMinutes: 90,
      availableFrom: '2030-01-07T09:00:00Z',
      acceptUntil: '2030-01-07T17:00:00Z',
      scheduleWindowStart: '2030-01-02T09:00:00Z',
      scheduleWindowEnd: '2030-01-06T17:00:00Z'
    }
    vi.mocked(prisma.assignment.create).mockResolvedValue({ id: 'asgn-1' } as any)

    const result = await assignmentCreate(event)

    expect(result.statusCode).toBe(201)
    expect(prisma.assignment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        isSchedulable: true,
        cbtfDurationMinutes: 90,
        scheduleWindowStart: new Date('2030-01-02T09:00:00Z'),
        scheduleWindowEnd: new Date('2030-01-06T17:00:00Z')
      })
    })
  })

  describe('DELETE /api/admin/assignments/:id', () => {
    it('should throw 403 if not admin', async () => {
      const event = mockEvent('USER', { id: 'asgn-1' })
      try {
        await assignmentDelete(event)
      } catch (e: any) {
        expect(e.statusCode).toBe(403)
      }
    })

    it('should throw 404 if assignment does not exist', async () => {
      const event = mockEvent('ADMIN', { id: 'asgn-999' })
      vi.mocked(prisma.assignment.findUnique).mockResolvedValue(null)

      try {
        await assignmentDelete(event)
      } catch (e: any) {
        expect(e.statusCode).toBe(404)
      }
    })

    it('should delete assignment and return status: deleted', async () => {
      const event = mockEvent('ADMIN', { id: 'asgn-1' })
      vi.mocked(prisma.assignment.findUnique).mockResolvedValue({
        id: 'asgn-1',
        title: 'Test'
      } as any)
      vi.mocked(deleteAssignment).mockResolvedValue({ id: 'asgn-1' } as any)

      const result = await assignmentDelete(event)

      expect(deleteAssignment).toHaveBeenCalledWith('asgn-1')
      expect(result).toEqual({ status: 'deleted' })
    })
  })
})
