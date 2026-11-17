import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import availabilityGet from '../../../../../server/api/me/cbtf/availability.get'
import reservationsPost from '../../../../../server/api/me/cbtf/reservations.post'
import reservationPatch from '../../../../../server/api/me/cbtf/reservations/[id].patch'
import assignmentPatch from '../../../../../server/api/me/assignments/[id].patch'
import prisma from '@@/server/utils/db'

vi.mock('@@/server/utils/db', () => ({
  default: {
    assignment: { findUnique: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
    enrollment: { findFirst: vi.fn() },
    passRedemption: { findFirst: vi.fn() },
    cbtfReservation: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn() },
    cbtfFacility: { findMany: vi.fn(), findUnique: vi.fn() },
    cbtfScheduleException: { findFirst: vi.fn() },
    cbtfOperatingHours: { findUnique: vi.fn() },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn()
  }
}))
vi.mock('@@/server/utils/cbtf-canvas', () => ({
  syncCbtfReservationCanvasOverride: vi.fn().mockResolvedValue({})
}))
vi.mock('@@/server/services/alert.service', () => ({
  notifyCbtfScheduleFailure: vi.fn().mockResolvedValue(true)
}))
vi.mock('h3', async () => ({
  ...await vi.importActual('h3'),
  defineEventHandler: (handler: any) => handler,
  getQuery: (event: any) => event.query,
  readBody: async (event: any) => event.body,
  readValidatedBody: async (event: any, validate: any) => validate(event.body),
  getRouterParam: () => 'reservation',
  createError: (options: any) => Object.assign(new Error(options.statusMessage), options)
}))

const assignmentId = 'clh1234567890123456789012'
const assignment = {
  id: assignmentId, courseId: 'course', title: 'Exam', isSchedulable: true, cbtfDurationMinutes: 75,
  availableFrom: new Date('2030-01-07T09:00:00Z'), acceptUntil: new Date('2030-01-07T12:00:00Z'),
  scheduleWindowStart: new Date('2030-01-01T00:00:00Z'), scheduleWindowEnd: new Date('2030-01-05T00:00:00Z')
}
const facilities = ['a', 'b'].map(id => ({
  id, name: `Center ${id}`, timezone: 'UTC', totalSeats: 24,
  seatAllocationOrder: Array.from({ length: 24 }, (_, i) => i + 1)
}))
function event(startTime = '2030-01-07T10:45:00Z') {
  return { query: { assignmentId }, body: { assignmentId, facilityId: 'b', startTime } } as any
}

describe('CBTF exam dates versus reservation action dates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2030-01-02T00:00:00Z'))
    vi.spyOn(Math, 'random').mockReturnValue(0.999)
    vi.stubGlobal('getUserSession', async () => ({ user: { id: 'student', globalRole: 'USER' } }))
    vi.mocked(prisma.assignment.findUnique).mockResolvedValue(assignment as any)
    vi.mocked(prisma.enrollment.findFirst).mockResolvedValue({ id: 'enrollment' } as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ enrollments: [{ role: 'TEACHER' }] } as any)
    vi.mocked(prisma.passRedemption.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.cbtfReservation.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.cbtfReservation.findUnique).mockResolvedValue({
      id: 'reservation', facilityId: 'a', userId: 'student', status: 'SCHEDULED', assignment
    } as any)
    vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValue([])
    vi.mocked(prisma.cbtfReservation.count).mockResolvedValue(0)
    vi.mocked(prisma.cbtfFacility.findMany).mockResolvedValue(facilities as any)
    vi.mocked(prisma.cbtfFacility.findUnique).mockResolvedValue(facilities[1] as any)
    vi.mocked(prisma.cbtfScheduleException.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.cbtfOperatingHours.findUnique).mockResolvedValue({ openTime: '08:00', closeTime: '17:00' } as any)
    vi.mocked(prisma.$transaction).mockImplementation((async (cb: any) => cb(prisma)) as any)
    const persisted = async ({ data }: any) => ({ id: 'reservation', ...data })
    vi.mocked(prisma.cbtfReservation.create).mockImplementation(persisted as any)
    vi.mocked(prisma.cbtfReservation.update).mockImplementation(persisted as any)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('offers only later exam dates at both facilities while the reservation window is open now', async () => {
    const { data } = await availabilityGet(event())
    expect(data.studentWindow.start).toBe(assignment.availableFrom.toISOString())
    expect(data.studentWindow.end).toBe(assignment.acceptUntil.toISOString())
    expect(data.blocks.map(b => b.facilityId)).toEqual(['a', 'b'])
    for (const facility of facilities) {
      const slots = data.hourlySlots.filter(s => s.facilityId === facility.id)
      expect(slots.length).toBeGreaterThan(0)
      expect(slots.every(s => new Date(s.startTime) >= assignment.availableFrom && new Date(s.endTime) <= assignment.acceptUntil)).toBe(true)
      expect(slots.at(-1)!.startTime).toBe('2030-01-07T10:45:00.000Z')
      expect(slots.at(-1)!.endTime).toBe('2030-01-07T12:00:00.000Z')
    }
  })

  it.each([['POST', reservationsPost], ['PATCH', reservationPatch]] as const)(
    '%s books a later exam ending exactly at Accept Until, using the chosen facility', async (_method, handler) => {
      const response = await handler(event())
      expect(response.data.facilityId).toBe('b')
      expect(response.data.endTime).toBe('2030-01-07T12:00:00.000Z')
    }
  )

  it.each([['POST', reservationsPost], ['PATCH', reservationPatch]] as const)(
    '%s rejects an exam ending after Accept Until or starting before Available From', async (_method, handler) => {
      for (const start of ['2030-01-07T10:50:00Z', '2030-01-07T08:55:00Z']) {
        await expect(handler(event(start))).rejects.toMatchObject({ statusCode: 400,
          statusMessage: expect.stringContaining('availability window') })
      }
      expect(prisma.cbtfReservation.create).not.toHaveBeenCalled()
      expect(prisma.cbtfReservation.update).not.toHaveBeenCalled()
    }
  )

  it.each([['POST', reservationsPost], ['PATCH', reservationPatch]] as const)(
    '%s rejects actions outside the reservation window even for valid exam dates', async (_method, handler) => {
      for (const now of ['2029-12-31T00:00:00Z', '2030-01-06T00:00:00Z']) {
        vi.setSystemTime(new Date(now))
        await expect(handler(event())).rejects.toMatchObject({ statusCode: 403,
          statusMessage: expect.stringContaining('Reservation Window') })
      }
      expect(prisma.cbtfReservation.create).not.toHaveBeenCalled()
      expect(prisma.cbtfReservation.update).not.toHaveBeenCalled()
    }
  )

  it.each([['POST', reservationsPost], ['PATCH', reservationPatch]] as const)(
    '%s allows actions exactly at reservation-window boundaries', async (_method, handler) => {
      for (const now of [assignment.scheduleWindowStart, assignment.scheduleWindowEnd]) {
        vi.setSystemTime(now)
        await expect(handler(event())).resolves.toMatchObject({ data: { facilityId: 'b' } })
      }
    }
  )

  it.each([['POST', reservationsPost], ['PATCH', reservationPatch]] as const)(
    '%s allows ending at facility close and rejects ending after it', async (_method, handler) => {
      const laterExam = { ...assignment, acceptUntil: new Date('2030-01-07T19:00:00Z') }
      vi.mocked(prisma.assignment.findUnique).mockResolvedValue(laterExam as any)
      vi.mocked(prisma.cbtfReservation.findUnique).mockResolvedValue({
        id: 'reservation', userId: 'student', status: 'SCHEDULED', assignment: laterExam
      } as any)
      vi.mocked(prisma.cbtfOperatingHours.findUnique).mockResolvedValue({ openTime: '08:00', closeTime: '12:00' } as any)
      await expect(handler(event())).resolves.toMatchObject({ data: { endTime: '2030-01-07T12:00:00.000Z' } })
      await expect(handler(event('2030-01-07T10:50:00Z'))).rejects.toMatchObject({ statusCode: 400,
        statusMessage: expect.stringContaining('closing time') })
    }
  )

  it.each([['POST', reservationsPost], ['PATCH', reservationPatch]] as const)(
    '%s rejects a fifth simultaneous start at a 48-seat facility', async (_method, handler) => {
      vi.mocked(prisma.cbtfFacility.findUnique).mockResolvedValue({
        ...facilities[1], totalSeats: 48, seatAllocationOrder: Array.from({ length: 48 }, (_, i) => i + 1)
      } as any)
      vi.mocked(prisma.cbtfReservation.count).mockResolvedValue(4)
      await expect(handler(event())).rejects.toMatchObject({ statusCode: 409,
        statusMessage: expect.stringContaining('Arrival capacity') })
      vi.mocked(prisma.cbtfReservation.count).mockResolvedValue(3)
      await expect(handler(event())).resolves.toMatchObject({ data: { facilityId: 'b' } })
      expect(prisma.$queryRaw).toHaveBeenCalled()
    }
  )

  it.each([['POST', reservationsPost], ['PATCH', reservationPatch]] as const)(
    '%s allocates a free physical seat despite repeated records on another seat', async (_method, handler) => {
      vi.mocked(prisma.cbtfFacility.findUnique).mockResolvedValue({
        ...facilities[1], totalSeats: 2, seatAllocationOrder: [2, 1]
      } as any)
      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValue([{ seatNumber: 1 }, { seatNumber: 1 }] as any)
      await expect(handler(event())).resolves.toMatchObject({ data: { seatNumber: 2 } })
      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValue([{ seatNumber: 1 }, { seatNumber: 2 }] as any)
      await expect(handler(event())).rejects.toMatchObject({ statusCode: 409 })
      expect(prisma.cbtfReservation.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ startTime: { lt: new Date('2030-01-07T12:00:00Z') },
          endTime: { gt: new Date('2030-01-07T10:45:00Z') } })
      }))
    }
  )

  it('preserves the existing retake-pass exam window override', async () => {
    vi.mocked(prisma.passRedemption.findFirst).mockResolvedValue({
      id: 'pass', availableFrom: new Date('2030-01-08T09:00:00Z'), acceptUntil: new Date('2030-01-08T10:15:00Z')
    } as any)
    const { data } = await availabilityGet(event())
    expect(data.studentWindow.isPassWindow).toBe(true)
    expect(data.hourlySlots.every(s => s.startTime === '2030-01-08T09:00:00.000Z' && s.endTime === '2030-01-08T10:15:00.000Z')).toBe(true)
  })

  it.each([
    { availableFrom: '2030-01-07T13:00:00Z' },
    { acceptUntil: '2030-01-07T10:00:00Z' },
    { scheduleWindowEnd: '2029-12-31T00:00:00Z' },
    { cbtfDurationMinutes: 240 }, { availableFrom: null }
  ])('rejects an invalid instructor partial edit against saved values: %j', async body => {
    await expect(assignmentPatch({ body } as any)).rejects.toMatchObject({ statusCode: 400 })
    expect(prisma.assignment.update).not.toHaveBeenCalled()
  })
})
