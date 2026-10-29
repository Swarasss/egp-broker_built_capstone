import { describe, it, expect, vi, beforeEach } from 'vitest'
import assignmentsPatch from '../../../../../server/api/me/assignments/[id].patch'
import assignmentsGet from '../../../../../server/api/me/assignments.get'
import { getCourseAssignments } from '../../../../../server/utils/assignments'
import prisma from '@@/server/utils/db'

vi.mock('../../../../../server/utils/assignments', () => ({
  getCourseAssignments: vi.fn()
}))

vi.mock('@@/server/utils/db', () => ({
  default: {
    assignment: { findUnique: vi.fn(), update: vi.fn() },
    user: {
      findUnique: vi.fn()
    }
  }
}))

// Mock global getUserSession
vi.stubGlobal('getUserSession', (event: any) => Promise.resolve({ user: event.context.user }))

describe('API: Me Assignments GET', () => {
  const mockEvent = (userRole: string | null = 'STUDENT') =>
    ({
      context: {
        user: userRole ? { id: 'u1', globalRole: userRole } : null
      },
      node: {
        req: {
          method: 'GET'
        }
      }
    }) as any

  // Mocking h3 defineEventHandler
  vi.mock('h3', async () => {
    const actual = await vi.importActual('h3')
    return {
      ...actual,
      defineEventHandler: (handler: any) => handler,
      getRouterParam: () => 'a1',
      readValidatedBody: async (event: any, parse: any) => parse(event.body),
      createError: (opts: any) => opts
    }
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should return assignments if user has current course context', async () => {
    const event = mockEvent()

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      currentCourseId: 'c1'
    } as any)

    const mockAssignments = [{ id: 'a1', title: 'Assignment 1' }]
    vi.mocked(getCourseAssignments).mockResolvedValue(mockAssignments as any)

    const result = await assignmentsGet(event)

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'u1' },
      select: { currentCourseId: true }
    })
    expect(getCourseAssignments).toHaveBeenCalledWith('c1', 'u1')
    expect(result.data).toEqual(mockAssignments)
  })

  it('should throw 403 if no course context', async () => {
    const event = mockEvent()

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      currentCourseId: null
    } as any)

    await expect(assignmentsGet(event)).rejects.toThrowError(
      expect.objectContaining({ statusCode: 403 })
    )

    expect(getCourseAssignments).not.toHaveBeenCalled()
  })
})

describe('API: Me Assignments PATCH CBTF duration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.assignment.findUnique).mockResolvedValue({
      id: 'a1', courseId: 'c1', cbtfDurationMinutes: 120
    } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      enrollments: [{ courseId: 'c1', role: 'TEACHER' }]
    } as any)
    vi.mocked(prisma.assignment.update).mockResolvedValue({ id: 'a1' } as any)
  })

  it.each([
    ['custom duration', { cbtfDurationMinutes: 37 }, 37],
    ['explicit null', { cbtfDurationMinutes: null }, null],
    ['omission preserves existing duration', {}, undefined]
  ])('supports %s', async (_name, body, expected) => {
    await assignmentsPatch({
      context: { user: { id: 'u1', globalRole: 'USER' } }, body
    } as any)

    expect(prisma.assignment.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: expect.objectContaining({ cbtfDurationMinutes: expected })
    })
  })
})
