import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import availabilityGet from '../../../../../server/api/me/cbtf/availability.get'
import prisma from '@@/server/utils/db'

vi.mock('@@/server/utils/db', () => ({
  default: {
    assignment: { findUnique: vi.fn() },
    enrollment: { findFirst: vi.fn() },
    passRedemption: { findFirst: vi.fn() },
    cbtfReservation: { findFirst: vi.fn(), findMany: vi.fn() },
    cbtfFacility: { findMany: vi.fn() },
    cbtfSeat: { findMany: vi.fn().mockResolvedValue([]) },
    cbtfStudentAccommodation: { findUnique: vi.fn().mockResolvedValue(null) },
    cbtfScheduleException: { findFirst: vi.fn() },
    cbtfOperatingHours: { findUnique: vi.fn() }
  }
}))

vi.mock('h3', async () => ({
  ...await vi.importActual('h3'),
  defineEventHandler: (handler: any) => handler,
  getQuery: (event: any) => event.query,
  createError: (options: any) => Object.assign(new Error(options.statusMessage), options)
}))

const assignmentId = 'clh1234567890123456789012'
const windowStart = new Date('2030-01-07T09:10:00Z')
const windowEnd = new Date('2030-01-07T11:00:00Z')
const facilities = ['a', 'b'].map(id => ({
  id, name: `Center ${id}`, timezone: 'UTC', totalSeats: 1,
  operatingHours: [{ dayOfWeek: 1, openTime: '08:00', closeTime: '17:00' }], scheduleExceptions: [], seats: []
}))
const assignment = {
  id: assignmentId, courseId: 'course-1', title: 'Exam', isSchedulable: true,
  cbtfDurationMinutes: 60, availableFrom: windowStart, acceptUntil: windowEnd,
  scheduleWindowStart: new Date('2030-01-01T00:00:00Z'), scheduleWindowEnd: new Date('2030-01-05T00:00:00Z')
}
const current = {
  id: 'current', facilityId: 'a', userId: 'student', assignmentId, status: 'SCHEDULED', seatNumber: 1,
  startTime: new Date('2030-01-07T08:30:00Z'), endTime: new Date('2030-01-07T12:00:00Z')
}
let reservations: typeof current[]

function request(excludeReservationId?: string) {
  return availabilityGet({ query: { assignmentId, ...(excludeReservationId ? { excludeReservationId } : {}) } } as any)
}

describe('Step 3 student CBTF availability', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    vi.stubGlobal('getUserSession', async () => ({ user: { id: 'student', globalRole: 'USER' } }))
    reservations = []
    vi.mocked(prisma.assignment.findUnique).mockResolvedValue(assignment as any)
    vi.mocked(prisma.enrollment.findFirst).mockResolvedValue({ id: 'enrollment' } as any)
    vi.mocked(prisma.passRedemption.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.cbtfFacility.findMany).mockResolvedValue(facilities as any)
    vi.mocked(prisma.cbtfSeat.findMany).mockResolvedValue([])
    vi.mocked(prisma.cbtfStudentAccommodation.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.cbtfScheduleException.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.cbtfOperatingHours.findUnique).mockResolvedValue({ openTime: '08:00', closeTime: '17:00' } as any)
    vi.mocked(prisma.cbtfReservation.findFirst).mockImplementation(async ({ where }: any) =>
      (reservations.find(r => (!where.id || r.id === where.id) && r.userId === where.userId &&
        r.assignmentId === where.assignmentId && where.status.in.includes(r.status)) ?? null) as any
    )
    // Model the database predicates, including overlap and exclusion, instead of returning all rows.
    vi.mocked(prisma.cbtfReservation.findMany).mockImplementation(async ({ where }: any) =>
      reservations.filter(r => where.facilityId.in.includes(r.facilityId) && r.id !== where.id?.not &&
        where.status.in.includes(r.status) && r.startTime < where.startTime.lt && r.endTime > where.endTime.gt) as any
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each([60, 90])('clips every facility to exact window boundaries with a %i-minute exam', async duration => {
    vi.mocked(prisma.assignment.findUnique).mockResolvedValue({ ...assignment, cbtfDurationMinutes: duration } as any)
    const { data } = await request()
    expect(data.blocks).toHaveLength(1)
    expect(data.hourlySlots).toHaveLength((110 - duration) / 5 + 1)
    expect(data.hourlySlots.at(-1)!.endTime).toBe(windowEnd.toISOString())
    for (const slot of data.hourlySlots) {
      expect(+new Date(slot.startTime)).toBeGreaterThanOrEqual(+windowStart)
      expect(+new Date(slot.endTime) - +new Date(slot.startTime)).toBe(duration * 60_000)
      expect(new Date(slot.startTime).getUTCMinutes() % 5).toBe(0)
    }
  })

  it('allows a slot starting exactly at the window start', async () => {
    const { data } = await request()
    expect(data.hourlySlots.filter(s => s.startTime === windowStart.toISOString())).toHaveLength(1)
  })

  it('returns no blocks when the full duration cannot fit inside the window', async () => {
    vi.mocked(prisma.assignment.findUnique).mockResolvedValue({ ...assignment, cbtfDurationMinutes: 120 } as any)
    const { data } = await request()
    expect(data.blocks).toEqual([])
    expect(data.hourlySlots).toEqual([])
    expect(data.recommendedDays).toEqual([])
  })

  it('uses the effective retake window for exact filtering', async () => {
    vi.mocked(prisma.passRedemption.findFirst).mockResolvedValue({
      id: 'pass', availableFrom: new Date('2030-01-07T10:15:00Z'), acceptUntil: new Date('2030-01-07T11:15:00Z')
    } as any)
    const { data } = await request()
    expect(data.studentWindow.isPassWindow).toBe(true)
    expect(data.hourlySlots).toHaveLength(1)
    expect(data.hourlySlots.every(s => s.startTime === '2030-01-07T10:15:00.000Z' && s.endTime === '2030-01-07T11:15:00.000Z')).toBe(true)
  })

  it('excludes the current reservation only for rescheduling, across facilities', async () => {
    reservations = [current]
    const normal = await request()
    expect(normal.data.recommendedDays.map(b => b.facilityId)).toEqual(['b'])
    const rescheduling = await request('current')
    expect(rescheduling.data.recommendedDays.map(b => b.facilityId)).toEqual(['a', 'b'])
    expect(rescheduling.data.activeReservation?.id).toBe('current')
    expect(prisma.cbtfReservation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { not: 'current' }, startTime: { lt: windowEnd }, endTime: { gt: windowStart } })
    }))
  })

  it('still counts every other overlapping reservation, including starts before the window', async () => {
    reservations = [current, { ...current, id: 'other', userId: 'another-student' }]
    const { data } = await request('current')
    expect(data.recommendedDays.map(b => b.facilityId)).toEqual(['b'])
    expect(data.hourlySlots.length).toBeGreaterThan(0)
  })

  it.each([
    { userId: 'another-student' }, { assignmentId: 'another-assignment' }, { status: 'CHECKED_IN' }
  ])('does not allow excluding an ineligible reservation: %j', async change => {
    reservations = [{ ...current, ...change }]
    await expect(request('current')).rejects.toMatchObject({ statusCode: 404 })
    expect(prisma.cbtfReservation.findMany).not.toHaveBeenCalled()
  })

  it('rejects an unknown exclusion ID', async () => {
    await expect(request('unknown')).rejects.toMatchObject({ statusCode: 404 })
    expect(prisma.cbtfReservation.findMany).not.toHaveBeenCalled()
  })
})
