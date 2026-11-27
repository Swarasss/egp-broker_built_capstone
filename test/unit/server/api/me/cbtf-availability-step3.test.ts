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

function request(excludeReservationId?: string, query: Record<string, string> = {}) {
  return availabilityGet({
    query: { assignmentId, ...query, ...(excludeReservationId ? { excludeReservationId } : {}) }
  } as any)
}

function requestNarrowing(excludeReservationId?: string) {
  return request(excludeReservationId, { view: 'narrowing' })
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
    expect(normal.data.availabilityStatus).toBe('STUDENT_CONFLICT')
    expect(normal.data.hourlySlots).toEqual([])
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

  it('blocks only overlapping starts across facilities, including a checked-in reservation for another assignment', async () => {
    reservations = [{
      ...current, assignmentId: 'other-exam', status: 'CHECKED_IN',
      startTime: new Date('2030-01-07T08:30:00Z'), endTime: new Date('2030-01-07T09:30:00Z')
    }, {
      ...current, id: 'cancelled', status: 'CANCELLED'
    }]
    const { data } = await request()
    expect(data.availabilityStatus).toBe('AVAILABLE')
    expect(data.hourlySlots[0]?.startTime).toBe('2030-01-07T09:30:00.000Z')
    expect(data.hourlySlots.at(-1)?.startTime).toBe('2030-01-07T10:00:00.000Z')
  })

  it('permits an exam to end exactly when another reservation starts', async () => {
    reservations = [{
      ...current, assignmentId: 'other-exam',
      startTime: new Date('2030-01-07T10:10:00Z'), endTime: new Date('2030-01-07T11:30:00Z')
    }]
    const { data } = await request()
    expect(data.hourlySlots.map(slot => slot.startTime)).toEqual([windowStart.toISOString()])
  })

  it.each([1, 2, 5])('evaluates every configured facility when there are %i facilities', async count => {
    const centers = Array.from({ length: count }, (_, index) => ({ ...facilities[0], id: `center-${index}` }))
    vi.mocked(prisma.cbtfFacility.findMany).mockResolvedValue(centers as any)
    const { data } = await request()
    expect(prisma.cbtfFacility.findMany).toHaveBeenCalledWith({
      orderBy: { id: 'asc' }, include: { operatingHours: true, scheduleExceptions: true, seats: true }
    })
    expect(data.facilityDiagnostics.map(row => row.facilityId)).toEqual(centers.map(row => row.id))
    expect(data.facilityDiagnostics.every(row => row.status === 'AVAILABLE')).toBe(true)
    expect(data.blocks).toHaveLength(1)
    expect(data.hourlySlots).toHaveLength(11)
  })

  it('reports a full facility without consuming capacity at other facilities', async () => {
    reservations = [{ ...current, userId: 'other-student' }]
    const { data } = await request()
    expect(data.availabilityStatus).toBe('AVAILABLE')
    expect(data.facilityDiagnostics.map(row => row.status)).toEqual(['NO_AVAILABLE_SEATS', 'AVAILABLE'])
    expect(data.recommendedDays.map(day => day.facilityId)).toEqual(['b'])
    vi.mocked(prisma.cbtfFacility.findMany).mockResolvedValue([facilities[0]] as any)
    const full = (await request()).data
    expect(full).toMatchObject({ availabilityStatus: 'NO_AVAILABLE_SEATS', blocks: [], hourlySlots: [] })
  })

  it('distinguishes a facility without hours and a facility closed by an exception from an open facility', async () => {
    vi.mocked(prisma.cbtfFacility.findMany).mockResolvedValue([
      { ...facilities[0], operatingHours: [] },
      {
        ...facilities[1], timezone: 'America/New_York',
        operatingHours: [{ dayOfWeek: 1, openTime: '04:00', closeTime: '12:00' }],
        scheduleExceptions: [{ date: new Date('2030-01-07T00:00:00Z'), isClosed: true }]
      },
      { ...facilities[0], id: 'c' }
    ] as any)
    const { data } = await request()
    expect(data.availabilityStatus).toBe('AVAILABLE')
    expect(data.facilityDiagnostics.map(row => row.status)).toEqual([
      'NO_CONFIGURED_FACILITY_HOURS', 'NO_CONFIGURED_FACILITY_HOURS', 'AVAILABLE'
    ])
    expect(data.recommendedDays.map(day => day.facilityId)).toEqual(['c'])
  })

  it('reports arrival saturation separately when a seat is physically free', async () => {
    vi.mocked(prisma.cbtfFacility.findMany).mockResolvedValue([{ ...facilities[0], totalSeats: 2 }] as any)
    vi.mocked(prisma.assignment.findUnique).mockResolvedValue({
      ...assignment, acceptUntil: new Date('2030-01-07T10:10:00Z')
    } as any)
    reservations = [{ ...current, userId: 'other-student', startTime: windowStart }]
    expect((await request()).data).toMatchObject({ availabilityStatus: 'ARRIVAL_LIMIT_REACHED', blocks: [] })
  })

  it('returns a configuration reason if no facility has valid overlapping hours', async () => {
    vi.mocked(prisma.cbtfFacility.findMany).mockResolvedValue([
      { ...facilities[0], operatingHours: [] },
      { ...facilities[1], operatingHours: [{ dayOfWeek: 1, openTime: '99:00', closeTime: '17:00' }] }
    ] as any)
    expect((await request()).data).toMatchObject({
      availabilityStatus: 'NO_CONFIGURED_FACILITY_HOURS', blocks: [], hourlySlots: []
    })
  })

  it('suggests at most four feasible days backward from Accept Until and skips a closed nearby date', async () => {
    vi.mocked(prisma.assignment.findUnique).mockResolvedValue({
      ...assignment,
      availableFrom: new Date('2030-01-06T14:00:00Z'),
      acceptUntil: new Date('2030-01-13T12:45:00Z')
    } as any)
    vi.mocked(prisma.cbtfFacility.findMany).mockResolvedValue([{
      ...facilities[0],
      operatingHours: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        dayOfWeek, openTime: '08:00', closeTime: '17:00'
      })),
      scheduleExceptions: [{ date: new Date('2030-01-12T00:00:00Z'), isClosed: true }]
    }] as any)

    const { data } = await requestNarrowing()
    expect(data.availabilityStatus).toBe('AVAILABLE')
    const choices = data.schedulingChoices!
    expect(choices.afternoon.map(({ date }) => date)).toEqual([
      '2030-01-11', '2030-01-10', '2030-01-09', '2030-01-08'
    ])
    expect(choices.morning.map(({ date }) => date)).toEqual([
      '2030-01-13', '2030-01-11', '2030-01-10', '2030-01-09'
    ])
    expect(choices.morning[0]?.times.every(({ endTime }) => endTime <= '2030-01-13T12:45:00.000Z')).toBe(true)
  })

  it('recommends a validated start in each local hour and keeps noon in Morning until 12:30', async () => {
    vi.mocked(prisma.assignment.findUnique).mockResolvedValue({
      ...assignment,
      availableFrom: new Date('2030-01-07T16:10:00Z'),
      acceptUntil: new Date('2030-01-07T21:00:00Z')
    } as any)
    vi.mocked(prisma.cbtfFacility.findMany).mockResolvedValue([{
      ...facilities[0],
      timezone: 'America/New_York',
      operatingHours: [{ dayOfWeek: 1, openTime: '08:00', closeTime: '15:05' }]
    }] as any)
    const { data } = await requestNarrowing()
    const choices = data.schedulingChoices!
    expect(choices.morning).toHaveLength(1)
    expect(choices.afternoon).toHaveLength(1)
    expect(choices.morning[0]?.times.map(({ startTime }) => startTime.slice(11, 13))).toEqual(['16', '17'])
    expect(choices.afternoon[0]?.times.map(({ startTime }) => startTime.slice(11, 13))).toEqual(['17', '18', '19'])
    expect(choices.morning[0]!.times[1]!.startTime < '2030-01-07T17:30:00.000Z').toBe(true)
    expect(choices.afternoon[0]!.times[0]!.startTime >= '2030-01-07T17:30:00.000Z').toBe(true)
    expect((await requestNarrowing()).data.schedulingChoices).toEqual(choices)

    for (const period of ['morning', 'afternoon'] as const) {
      const raw = await request(undefined, { blockId: `2030-01-07-${period}:America/New_York` })
      const times = choices[period][0]!.times
      expect(times.map(({ startTime }) => startTime)).toEqual(times.map(({ startTime }) => startTime).sort())
      for (const { timezone, ...time } of times) {
        expect(timezone).toBe('America/New_York')
        expect(time.endTime <= '2030-01-07T20:05:00.000Z').toBe(true)
        expect(raw.data.hourlySlots).toContainEqual(time)
        expect(new Date(time.startTime).getUTCMinutes() % 5).toBe(0)
      }
    }
  })

  it('suggests the day while any facility can seat the student and drops it when both are full', async () => {
    reservations = [{ ...current, userId: 'someone-else' }]
    const available = (await requestNarrowing()).data
    expect(available.facilityDiagnostics.map(({ status }) => status)).toEqual(['NO_AVAILABLE_SEATS', 'AVAILABLE'])
    expect(available.schedulingChoices?.morning).toHaveLength(1)
    expect(available.schedulingChoices?.afternoon).toEqual([])
    expect(available.schedulingChoices?.morning[0]?.times[0]).not.toHaveProperty('facilityId')
    expect(available.schedulingChoices?.morning[0]?.times[0]).not.toHaveProperty('seatNumber')

    reservations.push({ ...current, id: 'other-facility', facilityId: 'b', userId: 'another-student' })
    const full = (await requestNarrowing()).data
    expect(full.availabilityStatus).toBe('NO_AVAILABLE_SEATS')
    expect(full.schedulingChoices).toEqual({ morning: [], afternoon: [] })
  })

  it('caps suggestions at six hourly representatives across facilities and keeps their exact starts', async () => {
    vi.mocked(prisma.assignment.findUnique).mockResolvedValue({
      ...assignment,
      availableFrom: new Date('2030-01-07T12:00:00Z'),
      acceptUntil: new Date('2030-01-08T00:00:00Z')
    } as any)
    vi.mocked(prisma.cbtfFacility.findMany).mockResolvedValue([
      {
        ...facilities[0],
        operatingHours: [{ dayOfWeek: 1, openTime: '08:00', closeTime: '15:00' }]
      },
      {
        ...facilities[1],
        operatingHours: [{ dayOfWeek: 1, openTime: '15:15', closeTime: '23:00' }]
      }
    ] as any)
    const { data } = await requestNarrowing()
    const starts = data.schedulingChoices?.afternoon[0]?.times.map(({ startTime }) => startTime)
    expect(starts).toHaveLength(6)
    expect(starts).toEqual([...starts!].sort())
    expect(new Set(starts!.map((time) => time.slice(11, 13))).size).toBe(6)
  })

  it('uses the same narrowing view for rescheduling and retains near-term starts', async () => {
    vi.setSystemTime(new Date('2030-01-07T09:12:00Z'))
    vi.mocked(prisma.assignment.findUnique).mockResolvedValue({
      ...assignment, acceptUntil: new Date('2030-01-07T10:15:00Z'),
      scheduleWindowEnd: new Date('2030-01-07T11:00:00Z')
    } as any)
    reservations = [current]
    expect((await requestNarrowing()).data.availabilityStatus).toBe('STUDENT_CONFLICT')
    const { data } = await requestNarrowing('current')
    expect(data.schedulingChoices?.morning[0]?.times[0]?.startTime).toBe('2030-01-07T09:15:00.000Z')
  })

  it('uses feasible capacity even when the same instant is in another facility’s local period', async () => {
    vi.mocked(prisma.assignment.findUnique).mockResolvedValue({
      ...assignment, availableFrom: new Date('2030-01-07T13:00:00Z'),
      acceptUntil: new Date('2030-01-07T14:05:00Z')
    } as any)
    vi.mocked(prisma.cbtfFacility.findMany).mockResolvedValue([
      facilities[0],
      {
        ...facilities[1], timezone: 'America/New_York',
        operatingHours: [{ dayOfWeek: 1, openTime: '08:05', closeTime: '12:00' }]
      }
    ] as any)
    const { data } = await requestNarrowing()
    expect(data.schedulingChoices?.afternoon[0]?.times).toEqual([{
      startTime: '2030-01-07T13:05:00.000Z', endTime: '2030-01-07T14:05:00.000Z',
      timezone: 'UTC', formattedTime: '1:05 PM'
    }])
    expect(prisma.cbtfReservation.findMany).toHaveBeenCalledTimes(1)
  })

  it('suggests 1:10 when earlier grid points are blocked and it is the only feasible start', async () => {
    vi.mocked(prisma.assignment.findUnique).mockResolvedValue({
      ...assignment, availableFrom: new Date('2030-01-07T13:00:00Z'),
      acceptUntil: new Date('2030-01-07T14:10:00Z')
    } as any)
    reservations = [
      { ...current, userId: 'other', startTime: new Date('2030-01-07T12:00:00Z'), endTime: new Date('2030-01-07T15:00:00Z') },
      { ...current, id: 'b-occupied', facilityId: 'b', userId: 'other', startTime: new Date('2030-01-07T12:00:00Z'), endTime: new Date('2030-01-07T13:10:00Z') }
    ]
    const times = (await requestNarrowing()).data.schedulingChoices?.afternoon[0]?.times
    expect(times?.map(({ startTime }) => startTime)).toEqual(['2030-01-07T13:10:00.000Z'])
  })

  it('uses the authenticated student for stable recommendations across requests', async () => {
    const recommendationFor = async (userId: string) => {
      vi.stubGlobal('getUserSession', async () => ({ user: { id: userId, globalRole: 'USER' } }))
      return (await requestNarrowing()).data.schedulingChoices?.morning[0]?.times[0]?.startTime
    }
    const first = await recommendationFor('student-a')
    expect(await recommendationFor('student-a')).toBe(first)
    const others = [first]
    for (const userId of ['student-b', 'student-c', 'student-d', 'student-e']) {
      others.push(await recommendationFor(userId))
    }
    expect(others.every(Boolean)).toBe(true)
    expect(new Set(others).size).toBeGreaterThan(1)
  })

  it('never suggests the sole start when arrivals are throttled despite a free eligible seat', async () => {
    vi.mocked(prisma.cbtfFacility.findMany).mockResolvedValue([{ ...facilities[0], totalSeats: 2 }] as any)
    vi.mocked(prisma.assignment.findUnique).mockResolvedValue({
      ...assignment, acceptUntil: new Date('2030-01-07T10:10:00Z')
    } as any)
    reservations = [{ ...current, userId: 'other', startTime: windowStart }]
    const { data } = await requestNarrowing()
    expect(data).toMatchObject({ availabilityStatus: 'ARRIVAL_LIMIT_REACHED', schedulingChoices: { morning: [], afternoon: [] } })
  })

  it('never suggests an ineligible seat or a start where extra time cannot fit', async () => {
    vi.mocked(prisma.cbtfStudentAccommodation.findUnique).mockResolvedValue({
      isActive: true, requiredSeatProperties: ['SSD'], timeMultiplier: 1
    } as any)
    expect((await requestNarrowing()).data.schedulingChoices).toEqual({ morning: [], afternoon: [] })
    vi.mocked(prisma.cbtfFacility.findMany).mockResolvedValue([{
      ...facilities[0], seats: [{ seatNumber: 1, properties: ['SSD'] }]
    }] as any)
    expect((await requestNarrowing()).data.schedulingChoices?.morning).toHaveLength(1)
    vi.mocked(prisma.cbtfStudentAccommodation.findUnique).mockResolvedValue({
      isActive: true, requiredSeatProperties: ['SSD'], timeMultiplier: 2
    } as any)
    expect((await requestNarrowing()).data.schedulingChoices).toEqual({ morning: [], afternoon: [] })
  })

  it('rejects an unknown exclusion ID', async () => {
    await expect(request('unknown')).rejects.toMatchObject({ statusCode: 404 })
    expect(prisma.cbtfReservation.findMany).not.toHaveBeenCalled()
  })
})
