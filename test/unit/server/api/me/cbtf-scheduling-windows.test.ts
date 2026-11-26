import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import availabilityGet from '../../../../../server/api/me/cbtf/availability.get'
import reservationsPost from '../../../../../server/api/me/cbtf/reservations.post'
import reservationPatch from '../../../../../server/api/me/cbtf/reservations/[id].patch'
import assignmentPatch from '../../../../../server/api/me/assignments/[id].patch'
import facilityPost from '../../../../../server/api/admin/cbtf/facility.post'
import facilityPatch from '../../../../../server/api/admin/cbtf/facility.patch'
import facilityDelete from '../../../../../server/api/admin/cbtf/facility/[id].delete'
import operatingHoursPost from '../../../../../server/api/admin/cbtf/operating-hours.post'
import prisma from '@@/server/utils/db'
import { notifyCbtfScheduleFailure } from '@@/server/services/alert.service'
import { syncCbtfReservationCanvasOverride } from '@@/server/utils/cbtf-canvas'

vi.mock('@@/server/utils/db', () => ({
  default: {
    assignment: { findUnique: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
    enrollment: { findFirst: vi.fn() },
    passRedemption: { findFirst: vi.fn() },
    cbtfReservation: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn() },
    cbtfFacility: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    cbtfProctorShift: { count: vi.fn() },
    cbtfSeat: { findMany: vi.fn().mockResolvedValue([]) },
    cbtfStudentAccommodation: { findUnique: vi.fn().mockResolvedValue(null) },
    cbtfScheduleException: { findFirst: vi.fn() },
    cbtfOperatingHours: { findUnique: vi.fn(), upsert: vi.fn() },
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
  getRouterParam: (event: any) => event.facilityId ?? 'reservation',
  createError: (options: any) => Object.assign(new Error(options.statusMessage), options)
}))

const assignmentId = 'clh1234567890123456789012'
const assignment = {
  id: assignmentId, courseId: 'course', title: 'Exam', isSchedulable: true, cbtfDurationMinutes: 90,
  availableFrom: new Date('2030-01-07T09:00:00Z'), acceptUntil: new Date('2030-01-07T12:00:00Z'),
  scheduleWindowStart: new Date('2030-01-01T00:00:00Z'), scheduleWindowEnd: new Date('2030-01-05T00:00:00Z')
}
const facilities = ['a', 'b'].map(id => ({
  id, name: `Center ${id}`, timezone: 'UTC', totalSeats: 24,
  seatAllocationOrder: Array.from({ length: 24 }, (_, i) => i + 1),
  seats: [], scheduleExceptions: [],
  operatingHours: [1, 2].map(dayOfWeek => ({ dayOfWeek, openTime: '08:00', closeTime: '17:00' }))
}))
function event(startTime = '2030-01-07T10:30:00Z') {
  return { query: { assignmentId }, body: { assignmentId, startTime } } as any
}

function mockFacilities(...centers: typeof facilities) {
  vi.mocked(prisma.cbtfFacility.findMany).mockResolvedValue(centers as any)
  vi.mocked(prisma.$queryRaw).mockResolvedValue(centers.map(({ id }) => ({ id })))
}

describe('CBTF exam dates versus reservation action dates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2030-01-02T00:00:00Z'))
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
    mockFacilities(...facilities)
    vi.mocked(prisma.cbtfFacility.findUnique).mockResolvedValue(facilities[1] as any)
    vi.mocked(prisma.cbtfScheduleException.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.cbtfOperatingHours.findUnique).mockResolvedValue({ openTime: '08:00', closeTime: '17:00' } as any)
    vi.mocked(prisma.cbtfSeat.findMany).mockResolvedValue([])
    vi.mocked(prisma.cbtfStudentAccommodation.findUnique).mockResolvedValue(null)
    vi.mocked(notifyCbtfScheduleFailure).mockResolvedValue(true as any)
    vi.mocked(syncCbtfReservationCanvasOverride).mockResolvedValue({} as any)
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
    expect(data.blocks).toHaveLength(1)
    const slots = data.hourlySlots
    expect(slots.length).toBeGreaterThan(0)
    expect(slots.every(s => new Date(s.startTime) >= assignment.availableFrom && new Date(s.endTime) <= assignment.acceptUntil)).toBe(true)
    expect(slots.at(-1)!.startTime).toBe('2030-01-07T10:30:00.000Z')
    expect(slots.at(-1)!.endTime).toBe('2030-01-07T12:00:00.000Z')
  })

  it.each([{ availableFrom: null }, { acceptUntil: null }, { cbtfDurationMinutes: 75 }])(
    'returns an explicit configuration error for %j', async change => {
      vi.mocked(prisma.assignment.findUnique).mockResolvedValue({ ...assignment, ...change } as any)
      await expect(availabilityGet(event())).rejects.toMatchObject({
        statusCode: 400, data: { availabilityStatus: 'INVALID_ASSIGNMENT_WINDOW' }
      })
      expect(prisma.cbtfFacility.findMany).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['2029-12-31T23:59:59Z', 'NOT_YET_OPEN', 'RESERVATION_NOT_OPEN'],
    ['2030-01-01T00:00:00Z', 'OPEN', 'AVAILABLE'],
    ['2030-01-05T00:00:00Z', 'OPEN', 'AVAILABLE'],
    ['2030-01-05T00:00:01Z', 'CLOSED', 'RESERVATION_CLOSED']
  ])('returns the same reservation-window decision as writes at %s', async (now, status, availabilityStatus) => {
    vi.setSystemTime(new Date(now))
    const { data } = await availabilityGet(event())
    expect(data).toMatchObject({
      reservationWindowStatus: status, availabilityStatus,
      reservationWindow: { start: assignment.scheduleWindowStart.toISOString(), end: assignment.scheduleWindowEnd.toISOString() }
    })
    if (status === 'OPEN') {
      expect(data.blocks.length).toBeGreaterThan(0)
    } else {
      expect(data.blocks).toEqual([])
      expect(data.hourlySlots).toEqual([])
      expect(prisma.cbtfFacility.findMany).not.toHaveBeenCalled()
    }
  })

  it('distinguishes expired starts from missing facility hours', async () => {
    vi.setSystemTime(new Date('2030-01-07T12:01:00Z'))
    vi.mocked(prisma.assignment.findUnique).mockResolvedValue({
      ...assignment, scheduleWindowEnd: new Date('2030-01-08T00:00:00Z')
    } as any)
    const { data } = await availabilityGet(event())
    expect(data).toMatchObject({ availabilityStatus: 'NO_FUTURE_STARTS', blocks: [] })
  })

  it('uses newly configured, resized, and deleted facilities on subsequent scheduling requests', async () => {
    const centers = new Map<string, any>([
      ['a', { ...facilities[0], totalSeats: 1, seatAllocationOrder: [1] }]
    ])
    const reservations = [
      { facilityId: 'a', seatNumber: 1, startTime: new Date('2030-01-07T08:55:00Z'), endTime: new Date('2030-01-07T12:00:00Z') }
    ]
    vi.stubGlobal('getUserSession', async (request: any) => ({
      user: { id: 'student', globalRole: request.role ?? 'USER' }
    }))
    const admin = (body: object = {}) => ({ role: 'ADMIN', body, facilityId: 'b' }) as any
    vi.mocked(prisma.cbtfFacility.findMany).mockImplementation(async (query: any) =>
      [...centers.values()].filter(center => query.where?.id.in.includes(center.id) ?? true)
    )
    vi.mocked(prisma.$queryRaw).mockImplementation(async (query: any) =>
      [...centers.keys()].filter(id => !query.values.length || query.values.includes(id)).map(id => ({ id }))
    )
    vi.mocked(prisma.cbtfFacility.findUnique).mockImplementation(async ({ where }) => centers.get(where.id!) ?? null)
    vi.mocked(prisma.cbtfFacility.create).mockImplementation(async ({ data }) => {
      const center = { ...data, id: 'b', seats: [], operatingHours: [], scheduleExceptions: [] }
      centers.set(center.id, center)
      return center as any
    })
    vi.mocked(prisma.cbtfFacility.update).mockImplementation(async ({ where, data }) => {
      const center = { ...centers.get(where.id!), ...data }
      centers.set(where.id!, center)
      return center
    })
    vi.mocked(prisma.cbtfFacility.delete).mockImplementation(async ({ where }) => {
      const center = centers.get(where.id!)
      centers.delete(where.id!)
      return center
    })
    vi.mocked(prisma.cbtfOperatingHours.upsert).mockImplementation(async ({ create }) => {
      const center = centers.get(create.facilityId)
      center.operatingHours = center.operatingHours.filter((hours: typeof create) => hours.dayOfWeek !== create.dayOfWeek)
      center.operatingHours.push(create)
      return create as any
    })
    vi.mocked(prisma.cbtfReservation.findMany).mockImplementation(async ({ where }: any) =>
      reservations.filter(row => where.facilityId.in.includes(row.facilityId)) as any
    )
    vi.mocked(prisma.cbtfReservation.count).mockResolvedValue(0)
    vi.mocked(prisma.cbtfProctorShift.count).mockResolvedValue(0)

    const start = '2030-01-07T09:15:00.000Z'
    const request = event(start)
    const read = async () => (await availabilityGet(request)).data
    expect(await read()).toMatchObject({ configuredTotalSeats: 1, hourlySlots: [] })
    await expect(reservationsPost(request)).rejects.toMatchObject({ statusCode: 409 })

    const order = [1, 12, ...Array.from({ length: 10 }, (_, i) => i + 2)]
    const created = await facilityPost(admin({
      name: 'Center B', totalSeats: 12, timezone: 'America/New_York', seatAllocationOrder: order
    }))
    expect(created.data.timezone).toBe('America/New_York')
    expect(await read()).toMatchObject({ configuredTotalSeats: 13, hourlySlots: [] })
    await expect(reservationsPost(request)).rejects.toMatchObject({ statusCode: 409 })

    await operatingHoursPost(admin({ facilityId: 'b', dayOfWeek: 1, openTime: '04:15', closeTime: '07:00' }))
    const available = await read()
    expect(available.facilityDiagnostics.map(row => row.status)).toEqual(['NO_AVAILABLE_SEATS', 'AVAILABLE'])
    expect(available.blocks[0]?.timezone).toBe('America/New_York')
    expect(available.hourlySlots[0]).toMatchObject({ startTime: start, formattedTime: '4:15 AM' })
    await expect(reservationsPost(event('2030-01-07T09:10:00Z'))).rejects.toMatchObject({ statusCode: 409 })
    expect((await reservationsPost(request)).data).toMatchObject({ facilityId: 'b', seatNumber: 1 })

    reservations.push({
      facilityId: 'b', seatNumber: 1, startTime: new Date(start), endTime: new Date('2030-01-07T10:45:00Z')
    })
    expect((await read()).hourlySlots.some(slot => slot.startTime === start)).toBe(false)
    await expect(reservationsPost(request)).rejects.toMatchObject({ statusCode: 409 })

    const resized = await facilityPatch(admin({ facilityId: 'b', totalSeats: 13 }))
    expect(resized.data.seatAllocationOrder).toEqual([...order, 13])
    expect(await read()).toMatchObject({ configuredTotalSeats: 14 })
    expect((await read()).hourlySlots.some(slot => slot.startTime === start)).toBe(true)
    expect((await reservationsPost(request)).data).toMatchObject({ facilityId: 'b', seatNumber: 12 })

    reservations.pop()
    centers.get('b').scheduleExceptions.push({ date: new Date(start), isClosed: true })
    expect(await read()).toMatchObject({ configuredTotalSeats: 14, hourlySlots: [] })
    await expect(reservationsPost(request)).rejects.toMatchObject({ statusCode: 409 })
    centers.get('b').scheduleExceptions.pop()
    expect((await reservationsPost(request)).data.facilityId).toBe('b')

    await operatingHoursPost(admin({ facilityId: 'b', dayOfWeek: 1, openTime: '08:00', closeTime: '11:00' }))
    expect((await read()).facilityDiagnostics[1]?.status).toBe('NO_CONFIGURED_FACILITY_HOURS')
    await operatingHoursPost(admin({ facilityId: 'b', dayOfWeek: 1, openTime: '04:15', closeTime: '07:00' }))
    await facilityPatch(admin({ facilityId: 'b', timezone: 'UTC' }))
    expect((await read()).facilityDiagnostics[1]?.status).toBe('NO_CONFIGURED_FACILITY_HOURS')
    await facilityPatch(admin({ facilityId: 'b', timezone: 'America/New_York' }))
    expect((await read()).facilityDiagnostics[1]?.status).toBe('AVAILABLE')

    centers.get('b').seats = resized.data.seatAllocationOrder.map((seatNumber: number) => ({ seatNumber, properties: ['SSD'] }))
    expect((await read()).facilityDiagnostics[1]?.status).toBe('NO_AVAILABLE_SEATS')
    centers.get('b').seats = []
    expect((await read()).facilityDiagnostics[1]?.status).toBe('AVAILABLE')

    await facilityDelete(admin())
    expect(await read()).toMatchObject({
      configuredTotalSeats: 1, hourlySlots: [],
      facilityDiagnostics: [{ facilityId: 'a', status: 'NO_AVAILABLE_SEATS' }]
    })
    await expect(reservationsPost(request)).rejects.toMatchObject({ statusCode: 409 })
  })

  it.each([['POST', reservationsPost], ['PATCH', reservationPatch]] as const)(
    'availability and %s agree on near-term and past starts', async (method, handler) => {
      vi.setSystemTime(new Date('2030-01-07T09:02:00Z'))
      const openWindow = { ...assignment, scheduleWindowEnd: new Date('2030-01-07T12:00:00Z') }
      vi.mocked(prisma.assignment.findUnique).mockResolvedValue(openWindow as any)
      vi.mocked(prisma.cbtfReservation.findUnique).mockResolvedValue({
        id: 'reservation', facilityId: 'a', userId: 'student', status: 'SCHEDULED', assignment: openWindow
      } as any)
      const near = '2030-01-07T09:05:00.000Z'
      const past = '2030-01-07T09:00:00.000Z'
      const request = event(near)
      if (method === 'PATCH') {
        request.query.excludeReservationId = 'reservation'
        vi.mocked(prisma.cbtfReservation.findFirst).mockImplementation(async ({ where }: any) =>
          where.id === 'reservation' ? { id: 'reservation' } as any : null
        )
      }
      const { data } = await availabilityGet(request)
      expect(data.hourlySlots[0]?.startTime).toBe(near)
      expect(data.hourlySlots.some(slot => slot.startTime === past)).toBe(false)
      expect((await handler(request)).data.startTime).toBe(near)
      await expect(handler(event(past))).rejects.toMatchObject({
        statusCode: 400, statusMessage: expect.stringContaining('past')
      })
    }
  )

  it.each([['POST', reservationsPost], ['PATCH', reservationPatch]] as const)(
    '%s books a later exam ending exactly at Accept Until, using deterministic facility selection', async (_method, handler) => {
      const response = await handler(event())
      expect(response.data.facilityId).toBe('a')
      expect(response.data.endTime).toBe('2030-01-07T12:00:00.000Z')
    }
  )

  it.each([['POST', reservationsPost], ['PATCH', reservationPatch]] as const)(
    '%s rejects an exam ending after Accept Until or starting before Available From', async (_method, handler) => {
      for (const start of ['2030-01-07T10:35:00Z', '2030-01-07T08:55:00Z']) {
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
        await expect(handler(event())).resolves.toMatchObject({ data: { facilityId: 'a' } })
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
      mockFacilities(...facilities.map(facility => ({
        ...facility, operatingHours: [{ dayOfWeek: 1, openTime: '08:00', closeTime: '12:00' }]
      })))
      await expect(handler(event())).resolves.toMatchObject({ data: { endTime: '2030-01-07T12:00:00.000Z' } })
      await expect(handler(event('2030-01-07T10:35:00Z'))).rejects.toMatchObject({ statusCode: 409 })
    }
  )

  it.each([['POST', reservationsPost], ['PATCH', reservationPatch]] as const)(
    '%s enforces the exact start limit at a 48-seat facility', async (_method, handler) => {
      mockFacilities({ ...facilities[0]!, totalSeats: 48, seatAllocationOrder: Array.from({ length: 48 }, (_, i) => i + 1) })
      const simultaneous = Array.from({ length: 4 }, (_, i) => ({
        facilityId: 'a', seatNumber: i + 1,
        startTime: new Date('2030-01-07T10:30Z'), endTime: new Date('2030-01-07T12:00Z')
      }))
      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValue(simultaneous as any)
      await expect(handler(event())).rejects.toMatchObject({ statusCode: 409 })
      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValue(simultaneous.slice(0, 3) as any)
      await expect(handler(event())).resolves.toMatchObject({ data: { facilityId: 'a', seatNumber: 4 } })
      expect(prisma.$queryRaw).toHaveBeenCalled()
    }
  )

  it.each([['POST', reservationsPost], ['PATCH', reservationPatch]] as const)(
    '%s allocates a physical seat free for the full interval', async (_method, handler) => {
      mockFacilities({ ...facilities[0]!, totalSeats: 2, seatAllocationOrder: [2, 1] })
      const first = { facilityId: 'a', seatNumber: 1,
        startTime: new Date('2030-01-07T10:25Z'), endTime: new Date('2030-01-07T11:00Z') }
      const second = { ...first, startTime: new Date('2030-01-07T11:20Z'), endTime: new Date('2030-01-07T12:00Z') }
      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValue([first, second] as any)
      await expect(handler(event())).resolves.toMatchObject({ data: { seatNumber: 2 } })
      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValue([first, { ...second, seatNumber: 2 }] as any)
      await expect(handler(event())).rejects.toMatchObject({ statusCode: 409 })
    }
  )

  it('preserves the existing retake-pass exam window override', async () => {
    vi.mocked(prisma.passRedemption.findFirst).mockResolvedValue({
      id: 'pass', availableFrom: new Date('2030-01-08T09:00:00Z'), acceptUntil: new Date('2030-01-08T10:30:00Z')
    } as any)
    const { data } = await availabilityGet(event())
    expect(data.studentWindow.isPassWindow).toBe(true)
    expect(data.hourlySlots.every(s => s.startTime === '2030-01-08T09:00:00.000Z' && s.endTime === '2030-01-08T10:30:00.000Z')).toBe(true)
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
