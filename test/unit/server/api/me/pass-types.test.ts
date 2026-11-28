import { beforeEach, describe, expect, it, vi } from 'vitest'
import createPassType from '@@/server/api/me/pass-types.post'
import updatePassType from '@@/server/api/me/pass-types/[id].patch'
import prisma from '@@/server/utils/db'

vi.mock('@@/server/utils/db', () => ({
  default: {
    user: { findUnique: vi.fn() },
    passType: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
    passEligibility: { create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
    assignment: { findUnique: vi.fn(), update: vi.fn() },
    $transaction: vi.fn((run) => run(prisma))
  }
}))
vi.mock('h3', async () => ({
  ...await vi.importActual('h3'),
  defineEventHandler: (handler: any) => handler,
  getRouterParam: () => 'pass-1',
  readValidatedBody: (event: any, parse: (body: unknown) => unknown) => parse(event.body)
}))

const pass = { id: 'pass-1', courseId: 'course-1', titlePattern: null }
const assignments = [
  { id: 'a1', title: 'Quiz' }, { id: 'a2', title: 'Quiz' }, { id: 'a3', title: 'Lab' }
]
const request = (body: unknown) => ({ body }) as any

describe('Pass type assignment eligibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('getUserSession', async () => ({ user: { id: 'instructor', globalRole: 'USER' } }))
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      currentCourseId: pass.courseId, enrollments: [{ courseId: pass.courseId }]
    } as any)
    vi.mocked(prisma.passType.findUnique).mockResolvedValue(pass as any)
    vi.mocked(prisma.passType.create).mockResolvedValue(pass as any)
    vi.mocked(prisma.passType.update).mockResolvedValue(pass as any)
    vi.mocked(prisma.passType.findUniqueOrThrow).mockResolvedValue({
      ...pass, course: { assignments }, eligibilities: []
    } as any)
    vi.mocked(prisma.assignment.findUnique).mockResolvedValue({ dueDate: null } as any)
  })

  it('creates a manual eligibility by ID, even when another assignment has the same title', async () => {
    await expect(createPassType(request({
      name: 'Retake', assignmentIds: ['a2'], maxDaysPastDue: null
    }))).resolves.toMatchObject({ statusCode: 201 })
    expect(prisma.$transaction).toHaveBeenCalledOnce()
    expect(prisma.passEligibility.create).toHaveBeenCalledExactlyOnceWith({
      data: { assignmentId: 'a2', passTypeId: pass.id, isAutomatic: false }
    })
    expect(prisma.assignment.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'a2' } }))
    expect(prisma.passType.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.not.objectContaining({ assignmentIds: expect.anything() })
    }))
  })

  it('creates automatic eligibility for every regex match alongside an explicit selection', async () => {
    vi.mocked(prisma.passType.findUniqueOrThrow).mockResolvedValue({
      ...pass, titlePattern: '^Quiz$', course: { assignments }, eligibilities: []
    } as any)
    await createPassType(request({ name: 'Bulk pass', titlePattern: '^Quiz$', assignmentIds: ['a3'] }))
    expect(vi.mocked(prisma.passEligibility.create).mock.calls.map(([{ data }]) => data))
      .toEqual([
        { passTypeId: pass.id, assignmentId: 'a1', isAutomatic: true },
        { passTypeId: pass.id, assignmentId: 'a2', isAutomatic: true },
        { passTypeId: pass.id, assignmentId: 'a3', isAutomatic: false }
      ])
  })

  it('updates explicit links while retaining unrelated regex eligibility', async () => {
    vi.mocked(prisma.passType.findUniqueOrThrow).mockResolvedValue({
      ...pass, titlePattern: '^Quiz$', course: { assignments }, eligibilities: [
        { id: 'auto-1', assignmentId: 'a1', isAutomatic: true },
        { id: 'auto-2', assignmentId: 'a2', isAutomatic: true },
        { id: 'manual-3', assignmentId: 'a3', isAutomatic: false }
      ]
    } as any)
    await expect(updatePassType(request({ assignmentIds: ['a2'], titlePattern: '^Quiz$' })))
      .resolves.toMatchObject({ statusCode: 200 })
    expect(prisma.passEligibility.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'auto-2' }, data: { isAutomatic: false }
    })
    expect(prisma.passEligibility.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: { in: ['manual-3'] } }
    })
    expect(prisma.passEligibility.create).not.toHaveBeenCalled()
  })

  it('preserves explicit eligibility when an edit omits assignment IDs', async () => {
    vi.mocked(prisma.passType.findUniqueOrThrow).mockResolvedValue({
      ...pass, course: { assignments }, eligibilities: [
        { id: 'manual-2', assignmentId: 'a2', isAutomatic: false }
      ]
    } as any)
    await updatePassType(request({ hoursPerPass: 36 }))
    expect(prisma.passEligibility.create).not.toHaveBeenCalled()
    expect(prisma.passEligibility.update).not.toHaveBeenCalled()
    expect(prisma.passEligibility.deleteMany).not.toHaveBeenCalled()
  })

  it('rejects IDs outside the pass course and keeps numeric API validation strict', async () => {
    await expect(createPassType(request({ name: 'Retake', assignmentIds: ['elsewhere'] })))
      .rejects.toMatchObject({ statusCode: 400, statusMessage: 'Choose assignments from this course.' })
    await expect(updatePassType(request({ maxDaysPastDue: '1' }))).rejects.toThrow()
    expect(prisma.passEligibility.create).not.toHaveBeenCalled()
    expect(prisma.passType.update).not.toHaveBeenCalled()
  })
})
