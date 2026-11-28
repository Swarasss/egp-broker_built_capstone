import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import availabilityGet from '@@/server/api/me/cbtf/availability.get'
import reservationsPost from '@@/server/api/me/cbtf/reservations.post'
import prisma from '@@/server/utils/db'
import * as placement from '@@/server/utils/cbtf-placement'
import * as recommendations from '@@/server/utils/cbtf-recommendations'

vi.mock('@@/server/utils/db', () => ({
  default: {
    assignment: { findUnique: vi.fn() },
    enrollment: { findFirst: vi.fn() },
    passRedemption: { findMany: vi.fn().mockResolvedValue([]) },
    cbtfStudentAccommodation: { findUnique: vi.fn() },
    cbtfFacility: { findMany: vi.fn() },
    cbtfReservation: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn()
  }
}))

vi.mock('@@/server/utils/cbtf-canvas', () => ({
  syncCbtfReservationCanvasOverride: vi.fn(async () => ({ status: 'skipped' }))
}))

vi.mock('@@/server/services/alert.service', () => ({
  notifyCbtfScheduleFailure: vi.fn(async () => true)
}))

vi.mock('h3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('h3')>()),
  defineEventHandler: (handler: unknown) => handler,
  getQuery: (event: { query: Record<string, string> }) => event.query,
  readBody: (event: { body: Record<string, string> }) => Promise.resolve(event.body)
}))

const assignmentId = 'clh1234567890123456789012'
const minute = 60_000
const at = (time: string) => new Date(`2030-01-07T${time}:00Z`)

function center(id: string, totalSeats: number) {
  return {
    id,
    name: `Center ${id.toUpperCase()}`,
    totalSeats,
    timezone: 'UTC',
    seatAllocationOrder: Array.from({ length: totalSeats }, (_, index) => index + 1),
    operatingHours: [{ dayOfWeek: 1, openTime: '12:00', closeTime: '21:00' }],
    scheduleExceptions: [],
    seats: []
  }
}

function reservation(
  facilityId: string,
  seatNumber: number,
  startTime: Date,
  endTime: Date,
  status = 'SCHEDULED'
) {
  const id = `${facilityId}-${seatNumber}-${+startTime}`
  return { id, facilityId, seatNumber, startTime, endTime, status, userId: `fixture-${id}` }
}

describe('CBTF recommendation stress regressions', () => {
  let userId: string
  let rows: ReturnType<typeof reservation>[]

  function setupCenters(a: number, b: number, cutoff: string) {
    const centers = [center('a', a), center('b', b)]
    vi.mocked(prisma.cbtfFacility.findMany).mockImplementation(async (args) => {
      const ids = args?.where?.id
      return centers.filter(
        ({ id }) =>
          !ids || (typeof ids === 'object' && Array.isArray(ids.in) && ids.in.includes(id))
      ) as any
    })
    vi.mocked(prisma.$queryRaw).mockResolvedValue(centers.map(({ id }) => ({ id })))
    vi.mocked(prisma.assignment.findUnique).mockResolvedValue({
      id: assignmentId,
      courseId: 'synthetic-course',
      title: 'Synthetic Exam',
      isSchedulable: true,
      cbtfDurationMinutes: 30,
      availableFrom: at('13:00'),
      acceptUntil: at(cutoff),
      scheduleWindowStart: new Date('2030-01-01T00:00:00Z'),
      scheduleWindowEnd: at('12:00'),
      course: { label: 'Synthetic Course' }
    } as any)
  }

  async function suggestions() {
    const { data } = await availabilityGet({ query: { assignmentId, view: 'narrowing' } } as any)
    return data.schedulingChoices?.afternoon[0]?.times ?? []
  }

  beforeEach(() => {
    vi.resetAllMocks()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2030-01-02T12:00:00Z'))
    userId = 'student-a'
    rows = []
    vi.stubGlobal('getUserSession', async () => ({ user: { id: userId, globalRole: 'USER' } }))
    vi.mocked(prisma.enrollment.findFirst).mockResolvedValue({ id: 'synthetic-enrollment' } as any)
    vi.mocked(prisma.passRedemption.findMany).mockResolvedValue([])
    vi.mocked(prisma.cbtfStudentAccommodation.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.cbtfReservation.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.cbtfReservation.findMany).mockImplementation(
      async ({ where }: any) =>
        rows.filter(
          (row) =>
            where.facilityId.in.includes(row.facilityId) &&
            where.status.in.includes(row.status) &&
            row.startTime < where.startTime.lt &&
            row.endTime > where.endTime.gt
        ) as any
    )
    vi.mocked(prisma.$transaction).mockImplementation((async (run: any) => run(prisma)) as any)
    vi.mocked(prisma.cbtfReservation.create).mockImplementation(
      async ({ data }) =>
        ({
          id: 'synthetic-booking',
          ...data,
          facility: { name: 'Center B' }
        }) as any
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('changes the hourly winner when exact or nearby arrivals increase', () => {
    const starts = ['13:10', '13:40'].map((time) => ({
      startTime: at(time),
      endTime: new Date(+at(time) + 30 * minute),
      timezone: 'UTC',
      hour: 13
    }))
    const feasible = [
      { eligibleSeatCount: 12, freeEligibleSeatCount: 8 },
      { eligibleSeatCount: 24, freeEligibleSeatCount: 18 }
    ]
    const capacity = new Map(starts.map(({ startTime }) => [+startTime, feasible]))
    const winner = (arrivals: Map<number, number>) =>
      recommendations.selectRecommendedStarts(starts, arrivals, capacity, userId, assignmentId)[0]!
    const baseline = winner(new Map())
    expect(baseline.startTime).toEqual(at('13:10'))
    const alternate = starts.find((slot) => slot !== baseline)!
    const timestamp = +baseline.startTime
    const exact = new Map([[timestamp, 4]])
    const adjacent = new Map([
      [timestamp - 5 * minute, 2],
      [timestamp + 5 * minute, 2]
    ])
    const farther = new Map([
      [timestamp - 10 * minute, 2],
      [timestamp + 10 * minute, 2]
    ])
    expect(winner(exact)).toBe(alternate)
    expect(winner(adjacent)).toBe(alternate)
    const score = (arrivals: Map<number, number>) =>
      recommendations.scoreRecommendedStart(timestamp, arrivals, feasible, userId, assignmentId)
    expect(score(exact) - score(new Map())).toBeCloseTo(12)
    expect(score(adjacent) - score(new Map())).toBeCloseTo(8)
    expect(score(farther) - score(new Map())).toBeCloseTo(4)
  })

  it('prefers more free capacity while still passing a B-only start to the scorer', async () => {
    setupCenters(1, 2, '13:35')
    rows = [reservation('a', 1, at('12:30'), at('13:05'), 'CHECKED_IN')]
    const sample = vi.spyOn(recommendations, 'selectRecommendedStarts')

    const times = await suggestions()

    expect(times.map(({ startTime }) => startTime)).toEqual([at('13:05').toISOString()])
    expect(sample).toHaveBeenCalledTimes(1)
    const [candidates, arrivals, capacity] = sample.mock.calls[0]!
    expect(candidates.map(({ startTime }) => +startTime).sort((a, b) => a - b)).toEqual([
      +at('13:00'),
      +at('13:05'),
      +at('13:05')
    ])
    expect(arrivals.get(+at('13:00'))).toBeUndefined()
    expect(arrivals.get(+at('13:05'))).toBeUndefined()
    expect(capacity.get(+at('13:00'))).toMatchObject([
      { eligibleSeatCount: 2, freeEligibleSeatCount: 2 }
    ])
    expect(capacity.get(+at('13:05'))).toMatchObject([
      { eligibleSeatCount: 1, freeEligibleSeatCount: 1 },
      { eligibleSeatCount: 2, freeEligibleSeatCount: 2 }
    ])
  })

  it('filters full and throttled starts before scoring, then books the exact B-only recommendation', async () => {
    setupCenters(1, 2, '13:45')
    rows = [
      reservation('a', 1, at('12:30'), at('14:00'), 'CHECKED_IN'),
      reservation('b', 1, at('12:30'), at('13:10'), 'CHECKED_IN'),
      reservation('b', 2, at('12:35'), at('13:10')),
      reservation('b', 1, at('13:15'), at('13:45'))
    ]
    const sample = vi.spyOn(recommendations, 'selectRecommendedStarts')
    const choosePlacement = vi.spyOn(placement, 'chooseCbtfPlacement')

    const [selected] = await suggestions()

    expect(selected).toEqual({
      startTime: at('13:10').toISOString(),
      endTime: at('13:40').toISOString(),
      timezone: 'UTC',
      formattedTime: '1:10 PM'
    })
    expect(sample).toHaveBeenCalledTimes(1)
    expect(sample.mock.calls[0]?.[0].map(({ startTime }) => startTime)).toEqual([at('13:10')])
    expect(choosePlacement).not.toHaveBeenCalled()

    const booked = await reservationsPost({
      body: { assignmentId, startTime: selected!.startTime }
    } as any)

    expect(booked).toMatchObject({
      statusCode: 201,
      data: {
        facilityId: 'b',
        seatNumber: 2,
        startTime: selected!.startTime,
        endTime: selected!.endTime
      }
    })
    expect(choosePlacement).toHaveBeenCalledExactlyOnceWith(
      prisma,
      ['a', 'b'],
      at('13:10'),
      at('13:40'),
      []
    )
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'ReadCommitted'
    })
    expect(vi.mocked(prisma.$queryRaw).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(prisma.cbtfReservation.findMany).mock.invocationCallOrder.at(-1)!
    )
  })

  it('aggregates 42 active reservations and returns six stable, distinct-hour recommendations', async () => {
    setupCenters(24, 36, '20:45')
    for (let wave = 0; wave <= 10; wave++) {
      const start = new Date(+at('13:00') + wave * 5 * minute)
      const end = new Date(+start + 30 * minute)
      for (const facilityId of ['a', 'b']) {
        rows.push(reservation(facilityId, wave * 2 + 1, start, end, 'CHECKED_IN'))
        if (wave < 10) rows.push(reservation(facilityId, wave * 2 + 2, start, end))
      }
    }
    expect(rows).toHaveLength(42)
    const sample = vi.spyOn(recommendations, 'selectRecommendedStarts')

    const first = await suggestions()
    expect(await suggestions()).toEqual(first)
    userId = 'student-b'
    const second = await suggestions()
    expect(await suggestions()).toEqual(second)
    const labels = (times: typeof first) => times.map(({ startTime }) => startTime.slice(11, 16))
    expect(labels(first)).toEqual(['14:30', '15:30', '16:30', '17:35', '18:20', '19:45'])
    expect(labels(second)).toEqual(['14:50', '15:55', '16:15', '17:40', '18:05', '19:45'])
    for (const times of [first, second]) {
      expect(times).toHaveLength(6)
      expect(new Set(times.map(({ startTime }) => new Date(startTime).getUTCHours())).size).toBe(6)
      expect(times.every(({ startTime }) => +new Date(startTime) % (5 * minute) === 0)).toBe(true)
    }
    const [candidates, arrivals, capacity] = sample.mock.calls[0]!
    expect(arrivals.get(+at('13:00'))).toBe(4)
    expect(arrivals.get(+at('13:50'))).toBe(2)
    expect(arrivals.size).toBe(11)
    // Center A hits its two-arrival limit. Center B has a third arrival available.
    expect(candidates.filter(({ startTime }) => +startTime === +at('13:00'))).toHaveLength(1)
    expect(capacity.get(+at('13:00'))).toMatchObject([{ eligibleSeatCount: 36 }])
    expect(prisma.cbtfReservation.findMany).toHaveBeenCalledTimes(4)
  })
})
