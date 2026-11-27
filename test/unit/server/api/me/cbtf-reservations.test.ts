import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import availabilityGet from '../../../../../server/api/me/cbtf/availability.get'
import reservationsGet from '../../../../../server/api/me/cbtf/reservations.get'
import reservationsPost from '../../../../../server/api/me/cbtf/reservations.post'
import reservationPatch from '../../../../../server/api/me/cbtf/reservations/[id].patch'
import reservationDelete from '../../../../../server/api/me/cbtf/reservations/[id].delete'
import {
  notifyCbtfScheduleSuccess,
  notifyCbtfScheduleFailure
} from '@@/server/services/alert.service'
import prisma from '@@/server/utils/db'
import * as cbtfCanvas from '@@/server/utils/cbtf-canvas'

vi.mock('@@/server/services/alert.service', () => ({
  notifyCbtfScheduleSuccess: vi.fn().mockResolvedValue(true),
  notifyCbtfScheduleFailure: vi.fn().mockResolvedValue(true)
}))

vi.mock('@@/server/utils/db', () => ({
  default: {
    assignment: { findUnique: vi.fn() },
    enrollment: { findFirst: vi.fn() },
    cbtfReservation: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn()
    },
    cbtfFacility: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    cbtfSeat: { findMany: vi.fn().mockResolvedValue([]) },
    cbtfStudentAccommodation: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
      deleteMany: vi.fn()
    },
    cbtfScheduleException: { findFirst: vi.fn() },
    cbtfOperatingHours: { findUnique: vi.fn() },
    passRedemption: { findFirst: vi.fn() },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn((cb) => cb(prisma))
  }
}))

// Mock global getUserSession
vi.stubGlobal('getUserSession', (event: any) =>
  Promise.resolve({ user: event.context?.user || null })
)

describe('API: CBTF Student Reservation Endpoints', () => {
  function configuredFacility(
    facility: { id: string; totalSeats: number; name?: string; timezone?: string; seatAllocationOrder?: number[] },
    openTime = '08:00',
    closeTime = '17:00'
  ) {
    return {
      ...facility,
      seats: [] as { seatNumber: number; properties: string[] }[],
      operatingHours: Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, openTime, closeTime })),
      scheduleExceptions: []
    }
  }

  function mockFacilities(...facilities: ReturnType<typeof configuredFacility>[]) {
    vi.mocked(prisma.cbtfFacility.findMany).mockResolvedValue(facilities as any)
    vi.mocked(prisma.$queryRaw).mockResolvedValue(facilities.map(({ id }) => ({ id })))
  }

  const mockEvent = (
    user: any = { id: 'usr-1', globalRole: 'USER' },
    query = {},
    body = {},
    routerParams = {}
  ) =>
    ({
      context: { user, params: routerParams },
      node: { req: { method: 'GET' } },
      _query: query,
      _body: body
    }) as any

  vi.mock('h3', async () => {
    const actual = await vi.importActual('h3')
    return {
      ...actual,
      defineEventHandler: (handler: any) => handler,
      getQuery: (event: any) => event._query || {},
      readBody: (event: any) => Promise.resolve(event._body || {}),
      getRouterParam: (event: any, name: string) => event.context?.params?.[name] || null,
      createError: (opts: any) => {
        const err = new Error(opts.statusMessage || 'Error')
        Object.assign(err, opts)
        return err
      }
    }
  })

  beforeEach(() => {
    // resetAllMocks also clears queued mockResolvedValueOnce entries so tests
    // never inherit state from an earlier failure.
    vi.resetAllMocks()
    // Some suites call vi.restoreAllMocks(); re-establish shared defaults so
    // tests never depend on execution order.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'))
    vi.mocked(prisma.$transaction).mockImplementation((async (cb: any) => cb(prisma)) as any)
    vi.mocked(prisma.$queryRaw).mockResolvedValue([] as any)
    vi.mocked(prisma.cbtfFacility.findMany).mockResolvedValue([])
    vi.mocked(prisma.cbtfSeat.findMany).mockResolvedValue([])
    vi.mocked(prisma.cbtfStudentAccommodation.findUnique).mockResolvedValue(null)
    vi.mocked(notifyCbtfScheduleSuccess).mockResolvedValue(true as any)
    vi.mocked(notifyCbtfScheduleFailure).mockResolvedValue(true as any)
    vi.mocked(prisma.cbtfReservation.findFirst).mockResolvedValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('GET /api/me/cbtf/availability', () => {
    it('throws 401 if unauthenticated', async () => {
      const event = mockEvent(null)
      await expect(availabilityGet(event)).rejects.toThrowError(
        expect.objectContaining({ statusCode: 401 })
      )
    })

    it('throws 400 if assignment is not schedulable', async () => {
      const event = mockEvent(
        { id: 'usr-1', globalRole: 'USER' },
        { assignmentId: 'clh1234567890123456789012' }
      )
      vi.mocked(prisma.assignment.findUnique).mockResolvedValue({
        id: 'clh1234567890123456789012',
        isSchedulable: false
      } as any)

      await expect(availabilityGet(event)).rejects.toThrowError(
        expect.objectContaining({
          statusCode: 400,
          statusMessage: 'Assignment is not configured for CBTF scheduling'
        })
      )
    })

    it.each([[90, '13:55'], [240, '14:00']] as const)(
      'merges the available five-minute starts for a %i-minute exam', async (duration, lastEnd) => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-09-30T00:00:00Z'))
        try {
          const assignmentId = 'clh1234567890123456789012'
          vi.mocked(prisma.assignment.findUnique).mockResolvedValue({
            id: assignmentId, courseId: 'course-1', title: 'Exam', isSchedulable: true,
            cbtfDurationMinutes: duration,
            scheduleWindowStart: new Date('2026-09-29T00:00:00Z'),
            scheduleWindowEnd: new Date('2026-10-01T00:00:00Z'),
            availableFrom: new Date('2026-10-01T00:00:00Z'),
            acceptUntil: new Date('2026-10-01T23:59:00Z')
          } as any)
          vi.mocked(prisma.enrollment.findFirst).mockResolvedValue({ id: 'enr-1' } as any)
          vi.mocked(prisma.passRedemption.findFirst).mockResolvedValue(null)
          vi.mocked(prisma.cbtfFacility.findMany).mockResolvedValue([
            configuredFacility({ id: 'small', timezone: 'UTC', totalSeats: 1 }, '08:02', '12:15'),
            configuredFacility({ id: 'large', timezone: 'UTC', totalSeats: 57 }, '09:00', '14:00')
          ] as any)
          vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValue([])
          const response = await availabilityGet(mockEvent(undefined, { assignmentId }))
          expect(response.data.blocks[0]!.id).toBe('2026-10-01-morning:UTC')
          const blockId = response.data.blocks[0]!.id
          const selected = await availabilityGet(mockEvent(undefined, { assignmentId, blockId }))
          const slots = selected.data.hourlySlots
          expect(slots[0]!.startTime).toBe('2026-10-01T08:05:00.000Z')
          expect(slots.at(-1)!.endTime).toBe(`2026-10-01T${lastEnd}:00.000Z`)
          expect(new Set(slots.map(slot => slot.startTime)).size).toBe(slots.length)
          for (const slot of slots) {
            expect(new Date(slot.startTime).getUTCMinutes() % 5).toBe(0)
            expect(+new Date(slot.endTime) - +new Date(slot.startTime)).toBe(duration * 60_000)
          }
          expect(prisma.cbtfFacility.create).not.toHaveBeenCalled()
        } finally {
          vi.useRealTimers()
        }
      }
    )

    it('returns availability recommendations for schedulable assignment', async () => {
      const event = mockEvent(
        { id: 'usr-1', globalRole: 'USER' },
        { assignmentId: 'clh1234567890123456789012', timeOfDayPreference: 'morning' }
      )

      vi.mocked(prisma.assignment.findUnique).mockResolvedValue({
        id: 'clh1234567890123456789012',
        courseId: 'course-1',
        title: 'Midterm 1',
        isSchedulable: true,
        availableFrom: new Date('2026-10-01T00:00:00.000Z'),
        scheduleWindowStart: new Date('2026-10-01T00:00:00.000Z'),
        acceptUntil: new Date('2026-10-15T00:00:00.000Z'),
        scheduleWindowEnd: new Date('2026-10-15T00:00:00.000Z')
      } as any)

      vi.mocked(prisma.enrollment.findFirst).mockResolvedValue({ id: 'enr-1' } as any)
      vi.mocked(prisma.cbtfReservation.findFirst).mockResolvedValue(null)
      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValue([])

      mockFacilities(configuredFacility({
        id: 'fac-1',
        name: 'Main Testing Center',
        totalSeats: 48,
        seatAllocationOrder: [1, 2, 3, 4],
        operatingHours: [{ dayOfWeek: 1, openTime: '08:00', closeTime: '17:00' }],
        scheduleExceptions: []
      }))


      const response = await availabilityGet(event)
      expect(response.statusCode).toBe(200)
      expect(response.data.assignmentTitle).toBe('Midterm 1')
      expect(response.data.activeReservation).toBeNull()
      expect(Array.isArray(response.data.recommendedDays)).toBe(true)
      expect(Array.isArray(response.data.blocks)).toBe(true)
    })
  })

  describe('GET /api/me/cbtf/reservations', () => {
    it('returns student reservations with the facility name', async () => {
      const event = mockEvent({ id: 'usr-1', globalRole: 'USER' })
      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValue([
        {
          id: 'res-1',
          facilityId: 'fac-1',
          assignmentId: 'asg-1',
          userId: 'usr-1',
          seatNumber: 3,
          startTime: new Date('2026-10-05T09:00:00.000Z'),
          endTime: new Date('2026-10-05T10:00:00.000Z'),
          status: 'SCHEDULED',
          assignment: { title: 'Midterm Exam' },
          facility: { name: 'Main CBTF Facility' },
          user: { firstName: 'Demo', lastName: 'User', studentId: '906000001', avatarUrl: null },
          checkedInAt: null,
          checkedOutAt: null,
          checkedInByUserId: null,
          checkedOutByUserId: null
        }
      ] as any)

      const response = await reservationsGet(event)
      expect(prisma.cbtfReservation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'usr-1' },
          include: expect.objectContaining({ facility: { select: { name: true } } })
        })
      )
      expect(response.statusCode).toBe(200)
      expect(response.data.length).toBe(1)
      expect(response.data[0].seatNumber).toBe(3)
      expect(response.data[0].assignmentTitle).toBe('Midterm Exam')
      expect(response.data[0].facilityName).toBe('Main CBTF Facility')
    })
  })

  describe('POST /api/me/cbtf/reservations', () => {
    it('rejects slot not aligned to 5-minute boundary', async () => {
      const event = mockEvent(
        { id: 'usr-1', globalRole: 'USER' },
        {},
        {
          assignmentId: 'clh1234567890123456789012',
          facilityId: 'fac-1',
          startTime: '2026-10-05T09:03:00.000Z' // 03 is not multiple of 5
        }
      )

      await expect(reservationsPost(event)).rejects.toThrowError(
        expect.objectContaining({
          statusCode: 400,
          statusMessage: expect.stringContaining('5-minute boundary')
        })
      )
    })

    it('rejects double booking on identical assignment', async () => {
      const event = mockEvent(
        { id: 'usr-1', globalRole: 'USER' },
        {},
        {
          assignmentId: 'clh1234567890123456789012',
          facilityId: 'fac-1',
          startTime: '2026-10-05T09:15:00.000Z'
        }
      )

      vi.mocked(prisma.assignment.findUnique).mockResolvedValue({
        id: 'clh1234567890123456789012',
        courseId: 'course-1',
        isSchedulable: true,
        availableFrom: new Date('2026-10-01T00:00:00.000Z'),
        scheduleWindowStart: new Date('2026-10-01T00:00:00.000Z'),
        acceptUntil: new Date('2026-10-15T00:00:00.000Z'),
        scheduleWindowEnd: new Date('2026-10-15T00:00:00.000Z')
      } as any)
      vi.mocked(prisma.enrollment.findFirst).mockResolvedValue({ id: 'enr-1' } as any)

      // Existing active reservation found
      vi.mocked(prisma.cbtfReservation.findFirst).mockResolvedValueOnce({
        id: 'res-existing',
        status: 'SCHEDULED'
      } as any)

      await expect(reservationsPost(event)).rejects.toThrowError(
        expect.objectContaining({
          statusCode: 409,
          statusMessage: expect.stringContaining('already have an active reservation')
        })
      )
    })

    it('rejects booking when start time is in the past', async () => {
      const pastTime = new Date(Date.now() - 3600000).toISOString()
      // Align with 5-minute boundary in the past
      const pastDate = new Date(pastTime)
      pastDate.setUTCMinutes(Math.floor(pastDate.getUTCMinutes() / 5) * 5, 0, 0)

      const event = mockEvent(
        { id: 'usr-1', globalRole: 'USER' },
        {},
        {
          assignmentId: 'clh1234567890123456789012',
          facilityId: 'fac-1',
          startTime: pastDate.toISOString()
        }
      )

      await expect(reservationsPost(event)).rejects.toThrowError(
        expect.objectContaining({
          statusCode: 400,
          statusMessage: 'Cannot schedule a reservation in the past'
        })
      )
    })

    it('rejects booking when student has overlapping reservation for another assignment', async () => {
      const event = mockEvent(
        { id: 'usr-1', globalRole: 'USER' },
        {},
        {
          assignmentId: 'clh1234567890123456789012',
          facilityId: 'fac-1',
          startTime: '2026-10-05T09:15:00.000Z'
        }
      )

      vi.mocked(prisma.assignment.findUnique).mockResolvedValue({
        id: 'clh1234567890123456789012',
        courseId: 'course-1',
        isSchedulable: true,
        cbtfDurationMinutes: 60,
        availableFrom: new Date('2026-10-01T00:00:00.000Z'),
        acceptUntil: new Date('2026-10-15T00:00:00.000Z'),
        scheduleWindowStart: new Date('2026-10-01T00:00:00.000Z'),
        scheduleWindowEnd: new Date('2026-10-15T00:00:00.000Z')
      } as any)
      vi.mocked(prisma.enrollment.findFirst).mockResolvedValue({ id: 'enr-1' } as any)

      // First call (existingActive for this assignment): null
      // Second call (conflictingSlot for any assignment): found conflicting reservation
      vi.mocked(prisma.cbtfReservation.findFirst)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'res-other',
          assignmentId: 'other-asg',
          assignment: { title: 'Midterm 2' }
        } as any)

      await expect(reservationsPost(event)).rejects.toThrowError(
        expect.objectContaining({
          statusCode: 409,
          statusMessage: expect.stringContaining('overlapping this time slot')
        })
      )
    })

    it('rejects booking when arrival throttle limit is reached', async () => {
      // 09:15 EDT is 13:15 UTC (within 08:00 - 17:00 EDT facility hours)
      const startTime = '2026-10-05T13:15:00.000Z'
      const event = mockEvent(
        { id: 'usr-1', globalRole: 'USER' },
        {},
        {
          assignmentId: 'clh1234567890123456789012',
          facilityId: 'fac-1',
          startTime
        }
      )

      vi.mocked(prisma.assignment.findUnique).mockResolvedValue({
        id: 'clh1234567890123456789012',
        courseId: 'course-1',
        isSchedulable: true,
        availableFrom: new Date('2026-10-01T00:00:00.000Z'),
        scheduleWindowStart: new Date('2026-10-01T00:00:00.000Z'),
        acceptUntil: new Date('2026-10-15T00:00:00.000Z'),
        scheduleWindowEnd: new Date('2026-10-15T00:00:00.000Z')
      } as any)
      vi.mocked(prisma.enrollment.findFirst).mockResolvedValue({ id: 'enr-1' } as any)
      vi.mocked(prisma.cbtfReservation.findFirst).mockResolvedValueOnce(null) // no existing for student

      mockFacilities(configuredFacility({
        id: 'fac-1',
        totalSeats: 48, // max arrivals = 4
        seatAllocationOrder: [1, 2, 3, 4]
      }))


      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValue(
        Array.from({ length: 4 }, (_, index) => ({
          facilityId: 'fac-1', seatNumber: index + 1,
          startTime: new Date(startTime), endTime: new Date('2026-10-05T14:15Z')
        })) as any
      )

      await expect(reservationsPost(event)).rejects.toThrowError(
        expect.objectContaining({
          statusCode: 409,
          statusMessage: expect.stringContaining('No eligible workstation')
        })
      )

      expect(notifyCbtfScheduleFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          errorType: expect.stringContaining('409'),
          errorMessage: expect.stringContaining('No eligible workstation'),
          errorLocation: expect.stringContaining('reservations.post.ts'),
          isReschedule: false
        })
      )
    })

    it('successfully books reservation and returns DTO with assigned seat', async () => {
      // 09:15 EDT is 13:15 UTC
      const startTime = '2026-10-05T13:15:00.000Z'
      const event = mockEvent(
        { id: 'usr-1', globalRole: 'USER' },
        {},
        {
          assignmentId: 'clh1234567890123456789012',
          facilityId: 'fac-1',
          startTime
        }
      )

      vi.mocked(prisma.assignment.findUnique).mockResolvedValue({
        id: 'clh1234567890123456789012',
        courseId: 'course-1',
        title: 'Midterm 1',
        isSchedulable: true,
        availableFrom: new Date('2026-10-01T00:00:00.000Z'),
        scheduleWindowStart: new Date('2026-10-01T00:00:00.000Z'),
        acceptUntil: new Date('2026-10-15T00:00:00.000Z'),
        scheduleWindowEnd: new Date('2026-10-15T00:00:00.000Z'),
        course: { label: 'CS 1114', title: 'Intro to Programming' }
      } as any)
      vi.mocked(prisma.enrollment.findFirst).mockResolvedValue({ id: 'enr-1' } as any)
      vi.mocked(prisma.cbtfReservation.findFirst).mockResolvedValue(null)

      mockFacilities(configuredFacility({
        id: 'fac-1',
        name: 'Main CBTF',
        totalSeats: 48,
        seatAllocationOrder: [1, 15, 29, 2]
      }))


      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValueOnce([]) // no active overlapping

      vi.mocked(prisma.cbtfReservation.create).mockResolvedValue({
        id: 'res-new',
        facilityId: 'fac-1',
        assignmentId: 'clh1234567890123456789012',
        userId: 'usr-1',
        seatNumber: 1,
        startTime: new Date(startTime),
        endTime: new Date('2026-10-05T14:15:00.000Z'),
        status: 'SCHEDULED',
        assignment: { title: 'Midterm 1' },
        user: { firstName: 'Demo', lastName: 'User', studentId: '906000001', avatarUrl: null },
        checkedInAt: null,
        checkedOutAt: null,
        checkedInByUserId: null,
        checkedOutByUserId: null
      } as any)

      const response = await reservationsPost(event)
      expect(response.statusCode).toBe(201)
      expect(response.data.id).toBe('res-new')
      expect(response.data.seatNumber).toBe(1)
      expect(response.data.status).toBe('SCHEDULED')
      expect(prisma.cbtfReservation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ seatNumber: 1 })
        })
      )
      expect(notifyCbtfScheduleSuccess).not.toHaveBeenCalled()
    })

    it('rejects booking when student has already completed the exam without a retake pass', async () => {
      const startTime = '2026-10-05T13:15:00.000Z'
      const event = mockEvent(
        { id: 'usr-1', globalRole: 'USER' },
        {},
        {
          assignmentId: 'clh1234567890123456789012',
          facilityId: 'fac-1',
          startTime
        }
      )

      vi.mocked(prisma.assignment.findUnique).mockResolvedValue({
        id: 'clh1234567890123456789012',
        courseId: 'course-1',
        title: 'Midterm 1',
        isSchedulable: true,
        availableFrom: new Date('2026-10-01T00:00:00.000Z'),
        scheduleWindowStart: new Date('2026-10-01T00:00:00.000Z'),
        acceptUntil: new Date('2026-10-15T00:00:00.000Z'),
        scheduleWindowEnd: new Date('2026-10-15T00:00:00.000Z'),
        course: { label: 'CS 1114', title: 'Intro to Programming' }
      } as any)
      vi.mocked(prisma.enrollment.findFirst).mockResolvedValue({ id: 'enr-1' } as any)

      // Active reservation is null, but completed reservation exists
      vi.mocked(prisma.cbtfReservation.findFirst)
        .mockResolvedValueOnce(null) // existingActive
        .mockResolvedValueOnce(null) // conflictingSlot
        .mockResolvedValueOnce({
          id: 'res-completed',
          status: 'CHECKED_OUT'
        } as any) // existingCompleted
      vi.mocked(prisma.passRedemption.findFirst).mockResolvedValue(null) // no retake pass

      await expect(reservationsPost(event)).rejects.toThrowError(
        expect.objectContaining({
          statusCode: 403,
          statusMessage: expect.stringContaining('already completed this exam')
        })
      )
    })

    it('allows booking when student has completed the exam and has a valid retake pass', async () => {
      const startTime = '2026-10-05T13:15:00.000Z'
      const event = mockEvent(
        { id: 'usr-1', globalRole: 'USER' },
        {},
        {
          assignmentId: 'clh1234567890123456789012',
          facilityId: 'fac-1',
          startTime
        }
      )

      vi.mocked(prisma.assignment.findUnique).mockResolvedValue({
        id: 'clh1234567890123456789012',
        courseId: 'course-1',
        title: 'Midterm 1',
        isSchedulable: true,
        availableFrom: new Date('2026-10-01T00:00:00.000Z'),
        scheduleWindowStart: new Date('2026-10-01T00:00:00.000Z'),
        acceptUntil: new Date('2026-10-15T00:00:00.000Z'),
        scheduleWindowEnd: new Date('2026-10-15T00:00:00.000Z'),
        course: { label: 'CS 1114', title: 'Intro to Programming' }
      } as any)
      vi.mocked(prisma.enrollment.findFirst).mockResolvedValue({ id: 'enr-1' } as any)

      // Completed reservation exists
      vi.mocked(prisma.cbtfReservation.findFirst)
        .mockResolvedValueOnce(null) // existingActive
        .mockResolvedValueOnce(null) // conflictingSlot
        .mockResolvedValueOnce({
          id: 'res-completed',
          status: 'CHECKED_OUT'
        } as any) // existingCompleted
        .mockResolvedValueOnce(null) // reusableReservation (no CANCELLED/MISSED to reuse)

      // Valid retake pass redemption
      vi.mocked(prisma.passRedemption.findFirst).mockResolvedValue({
        id: 'red-1',
        availableFrom: new Date('2026-10-01T00:00:00.000Z'),
        acceptUntil: new Date('2026-10-10T00:00:00.000Z')
      } as any)

      mockFacilities(configuredFacility({
        id: 'fac-1',
        name: 'Main CBTF',
        totalSeats: 48,
        seatAllocationOrder: [1, 15, 29, 2]
      }))


      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValueOnce([])
      vi.mocked(prisma.cbtfReservation.create).mockResolvedValueOnce({
        id: 'res-retake',
        facilityId: 'fac-1',
        assignmentId: 'clh1234567890123456789012',
        userId: 'usr-1',
        seatNumber: 1,
        startTime: new Date(startTime),
        endTime: new Date('2026-10-05T14:15:00.000Z'),
        status: 'SCHEDULED',
        assignment: { title: 'Midterm 1' },
        user: { firstName: 'Demo', lastName: 'User', studentId: '906000001', avatarUrl: null }
      } as any)

      const response = await reservationsPost(event)
      expect(response.statusCode).toBe(201)
      expect(response.data.id).toBe('res-retake')
      expect(prisma.cbtfReservation.create).toHaveBeenCalled()
    })

    it('reuses existing CANCELLED or MISSED reservation record when scheduling via POST', async () => {
      const startTime = '2026-10-05T13:15:00.000Z'
      const event = mockEvent(
        { id: 'usr-1', globalRole: 'USER' },
        {},
        {
          assignmentId: 'clh1234567890123456789012',
          facilityId: 'fac-1',
          startTime
        }
      )

      vi.mocked(prisma.assignment.findUnique).mockResolvedValue({
        id: 'clh1234567890123456789012',
        courseId: 'course-1',
        title: 'Midterm 1',
        isSchedulable: true,
        availableFrom: new Date('2026-10-01T00:00:00.000Z'),
        scheduleWindowStart: new Date('2026-10-01T00:00:00.000Z'),
        acceptUntil: new Date('2026-10-15T00:00:00.000Z'),
        scheduleWindowEnd: new Date('2026-10-15T00:00:00.000Z'),
        course: { label: 'CS 1114', title: 'Intro to Programming' }
      } as any)
      vi.mocked(prisma.enrollment.findFirst).mockResolvedValue({ id: 'enr-1' } as any)

      vi.mocked(prisma.cbtfReservation.findFirst)
        .mockResolvedValueOnce(null) // existingActive
        .mockResolvedValueOnce(null) // conflictingSlot
        .mockResolvedValueOnce(null) // existingCompleted
        .mockResolvedValueOnce({
          id: 'res-cancelled',
          status: 'CANCELLED'
        } as any) // reusableReservation

      mockFacilities(configuredFacility({
        id: 'fac-1',
        name: 'Main CBTF',
        totalSeats: 48,
        seatAllocationOrder: [1, 15, 29, 2]
      }))


      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValueOnce([])
      vi.mocked(prisma.cbtfReservation.update).mockResolvedValueOnce({
        id: 'res-cancelled',
        facilityId: 'fac-1',
        assignmentId: 'clh1234567890123456789012',
        userId: 'usr-1',
        seatNumber: 1,
        startTime: new Date(startTime),
        endTime: new Date('2026-10-05T14:15:00.000Z'),
        status: 'SCHEDULED',
        assignment: { title: 'Midterm 1' },
        user: { firstName: 'Demo', lastName: 'User', studentId: '906000001', avatarUrl: null }
      } as any)

      const response = await reservationsPost(event)
      expect(response.statusCode).toBe(201)
      expect(response.data.id).toBe('res-cancelled')
      expect(prisma.cbtfReservation.create).not.toHaveBeenCalled()
      expect(prisma.cbtfReservation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'res-cancelled' },
          data: expect.objectContaining({ status: 'SCHEDULED' })
        })
      )
    })
  })

  describe('PATCH /api/me/cbtf/reservations/[id]', () => {
    it('reschedules a missed reservation to a new slot', async () => {
      // 11:00 EDT is 15:00 UTC (within 08:00 - 17:00 EDT facility hours)
      const newStartTime = '2026-10-06T15:00:00.000Z'
      const event = mockEvent(
        { id: 'usr-1', globalRole: 'USER' },
        {},
        { facilityId: 'fac-1', startTime: newStartTime },
        { id: 'res-1' }
      )

      vi.mocked(prisma.cbtfReservation.findUnique).mockResolvedValue({
        id: 'res-1',
        userId: 'usr-1',
        status: 'MISSED',
        assignment: {
          id: 'asg-1',
          title: 'Midterm 1',
          availableFrom: new Date('2026-10-01T00:00:00.000Z'),
          scheduleWindowStart: new Date('2026-10-01T00:00:00.000Z'),
          acceptUntil: new Date('2026-10-15T00:00:00.000Z'),
          scheduleWindowEnd: new Date('2026-10-15T00:00:00.000Z')
        }
      } as any)

      mockFacilities(configuredFacility({
        id: 'fac-1',
        name: 'Main CBTF',
        totalSeats: 48,
        seatAllocationOrder: [1, 2, 3]
      }))


      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValue([])
      vi.mocked(prisma.cbtfReservation.findFirst).mockResolvedValue(null)

      vi.mocked(prisma.cbtfReservation.update).mockResolvedValue({
        id: 'res-1',
        facilityId: 'fac-1',
        assignmentId: 'asg-1',
        userId: 'usr-1',
        seatNumber: 1,
        startTime: new Date(newStartTime),
        endTime: new Date('2026-10-06T16:00:00.000Z'),
        status: 'SCHEDULED',
        assignment: { title: 'Midterm 1' },
        user: { firstName: 'Demo', lastName: 'User', studentId: '906000001', avatarUrl: null },
        checkedInAt: null,
        checkedOutAt: null,
        checkedInByUserId: null,
        checkedOutByUserId: null
      } as any)

      const response = await reservationPatch(event)
      expect(response.statusCode).toBe(200)
      expect(response.data.status).toBe('SCHEDULED')
      expect(response.data.startTime).toBe(newStartTime)
      expect(notifyCbtfScheduleSuccess).not.toHaveBeenCalled()
    })

    it('reschedules reservation when current status is CANCELLED', async () => {
      const newStartTime = '2026-10-06T15:00:00.000Z'
      const event = mockEvent(
        { id: 'usr-1', globalRole: 'USER' },
        {},
        { facilityId: 'fac-1', startTime: newStartTime },
        { id: 'res-1' }
      )

      vi.mocked(prisma.cbtfReservation.findUnique).mockResolvedValue({
        id: 'res-1',
        userId: 'usr-1',
        status: 'CANCELLED',
        assignment: {
          id: 'asg-1',
          title: 'Midterm 1',
          availableFrom: new Date('2026-10-01T00:00:00.000Z'),
          scheduleWindowStart: new Date('2026-10-01T00:00:00.000Z'),
          acceptUntil: new Date('2026-10-15T00:00:00.000Z'),
          scheduleWindowEnd: new Date('2026-10-15T00:00:00.000Z')
        }
      } as any)

      mockFacilities(configuredFacility({
        id: 'fac-1',
        name: 'Main CBTF',
        totalSeats: 48,
        seatAllocationOrder: [1, 2, 3]
      }))


      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValue([])
      vi.mocked(prisma.cbtfReservation.findFirst).mockResolvedValue(null)

      vi.mocked(prisma.cbtfReservation.update).mockResolvedValue({
        id: 'res-1',
        facilityId: 'fac-1',
        assignmentId: 'asg-1',
        userId: 'usr-1',
        seatNumber: 1,
        startTime: new Date(newStartTime),
        endTime: new Date('2026-10-06T16:00:00.000Z'),
        status: 'SCHEDULED',
        assignment: { title: 'Midterm 1' },
        user: { firstName: 'Demo', lastName: 'User', studentId: '906000001', avatarUrl: null },
        checkedInAt: null,
        checkedOutAt: null,
        checkedInByUserId: null,
        checkedOutByUserId: null
      } as any)

      const response = await reservationPatch(event)
      expect(response.statusCode).toBe(200)
      expect(response.data.status).toBe('SCHEDULED')
      expect(response.data.startTime).toBe(newStartTime)
    })

    it('rejects rescheduling when new start time is in the past', async () => {
      const pastTime = new Date(Date.now() - 3600000).toISOString()
      const pastDate = new Date(pastTime)
      pastDate.setUTCMinutes(Math.floor(pastDate.getUTCMinutes() / 5) * 5, 0, 0)

      const event = mockEvent(
        { id: 'usr-1', globalRole: 'USER' },
        {},
        { facilityId: 'fac-1', startTime: pastDate.toISOString() },
        { id: 'res-1' }
      )

      await expect(reservationPatch(event)).rejects.toThrowError(
        expect.objectContaining({
          statusCode: 400,
          statusMessage: 'Cannot reschedule to a time slot in the past'
        })
      )

      expect(notifyCbtfScheduleFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          errorType: expect.stringContaining('400'),
          errorMessage: 'Cannot reschedule to a time slot in the past',
          errorLocation: expect.stringContaining('reservations/[id].patch.ts'),
          isReschedule: true
        })
      )
    })

    it('rejects rescheduling when new time conflicts with student another active reservation', async () => {
      const newStartTime = '2026-10-06T11:00:00.000Z'
      const event = mockEvent(
        { id: 'usr-1', globalRole: 'USER' },
        {},
        { facilityId: 'fac-1', startTime: newStartTime },
        { id: 'res-1' }
      )

      vi.mocked(prisma.cbtfReservation.findUnique).mockResolvedValue({
        id: 'res-1',
        userId: 'usr-1',
        status: 'SCHEDULED',
        assignment: {
          id: 'asg-1',
          title: 'Midterm 1',
          cbtfDurationMinutes: 60,
          availableFrom: new Date('2026-10-01T00:00:00.000Z'),
          acceptUntil: new Date('2026-10-15T00:00:00.000Z'),
          scheduleWindowStart: new Date('2026-10-01T00:00:00.000Z'),
          scheduleWindowEnd: new Date('2026-10-15T00:00:00.000Z')
        }
      } as any)

      // Duplicate check, completed-exam check, then the conflicting reservation
      vi.mocked(prisma.cbtfReservation.findFirst)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'res-conflict',
          assignmentId: 'asg-2',
          assignment: { title: 'Quiz 2' }
        } as any)

      await expect(reservationPatch(event)).rejects.toThrowError(
        expect.objectContaining({
          statusCode: 409,
          statusMessage: expect.stringContaining('overlapping this time slot')
        })
      )
    })
  })

  describe('DELETE /api/me/cbtf/reservations/[id]', () => {
    it('cancels scheduled reservation', async () => {
      const event = mockEvent({ id: 'usr-1', globalRole: 'USER' }, {}, {}, { id: 'res-1' })

      vi.mocked(prisma.cbtfReservation.findUnique).mockResolvedValue({
        id: 'res-1',
        userId: 'usr-1',
        status: 'SCHEDULED'
      } as any)

      vi.mocked(prisma.cbtfReservation.update).mockResolvedValue({
        id: 'res-1',
        facilityId: 'fac-1',
        assignmentId: 'asg-1',
        userId: 'usr-1',
        seatNumber: 1,
        startTime: new Date('2026-10-06T11:00:00.000Z'),
        endTime: new Date('2026-10-06T12:00:00.000Z'),
        status: 'CANCELLED',
        assignment: { title: 'Midterm 1' },
        user: { firstName: 'Demo', lastName: 'User', studentId: '906000001', avatarUrl: null },
        checkedInAt: null,
        checkedOutAt: null,
        checkedInByUserId: null,
        checkedOutByUserId: null
      } as any)

      const response = await reservationDelete(event)
      expect(response.statusCode).toBe(200)
      expect(response.data.status).toBe('CANCELLED')
    })

    it('rejects cancelling a reservation already checked in', async () => {
      const event = mockEvent({ id: 'usr-1', globalRole: 'USER' }, {}, {}, { id: 'res-1' })

      vi.mocked(prisma.cbtfReservation.findUnique).mockResolvedValue({
        id: 'res-1',
        userId: 'usr-1',
        status: 'CHECKED_IN'
      } as any)

      await expect(reservationDelete(event)).rejects.toThrowError(
        expect.objectContaining({
          statusCode: 400,
          statusMessage: expect.stringContaining('Only scheduled reservations can be cancelled')
        })
      )
    })

    it('returns 404 when cancelling another user reservation', async () => {
      const event = mockEvent({ id: 'usr-1', globalRole: 'USER' }, {}, {}, { id: 'res-1' })

      vi.mocked(prisma.cbtfReservation.findUnique).mockResolvedValue({
        id: 'res-1',
        userId: 'usr-2',
        status: 'SCHEDULED'
      } as any)

      await expect(reservationDelete(event)).rejects.toThrowError(
        expect.objectContaining({ statusCode: 404 })
      )
    })

    it('rejects cancellation when status changed concurrently', async () => {
      const event = mockEvent({ id: 'usr-1', globalRole: 'USER' }, {}, {}, { id: 'res-1' })

      vi.mocked(prisma.cbtfReservation.findUnique).mockResolvedValue({
        id: 'res-1',
        userId: 'usr-1',
        status: 'SCHEDULED'
      } as any)

      vi.mocked(prisma.cbtfReservation.update).mockRejectedValueOnce(
        Object.assign(new Error('Record not found'), { code: 'P2025' })
      )

      await expect(reservationDelete(event)).rejects.toThrowError(
        expect.objectContaining({ statusCode: 409 })
      )
    })
  })

  describe('Configurable CBTF duration: persistence', () => {
    const assignmentId = 'clh1234567890123456789012'
    const startTime = '2030-01-07T10:00:00.000Z'

    beforeEach(() => {
      // Reset queued implementations left by stale-date tests before setting up this suite.
      vi.resetAllMocks()
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
      vi.mocked(prisma.$transaction).mockImplementation((async (cb: any) => cb(prisma)) as any)
      vi.mocked(prisma.enrollment.findFirst).mockResolvedValue({ id: 'enr-1' } as any)
      vi.mocked(prisma.cbtfReservation.findFirst).mockResolvedValue(null)
      vi.mocked(prisma.passRedemption.findFirst).mockResolvedValue(null)
      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValue([])
      vi.mocked(prisma.cbtfSeat.findMany).mockResolvedValue([])
      vi.mocked(prisma.cbtfStudentAccommodation.findUnique).mockResolvedValue(null)
      mockFacilities(configuredFacility({
        id: 'fac-1', name: 'Testing Center', timezone: 'UTC', totalSeats: 48,
        seatAllocationOrder: Array.from({ length: 48 }, (_, i) => i + 1)
      }))
    })

    afterEach(() => vi.useRealTimers())

    function assignment(duration: number | null) {
      return {
        id: assignmentId, courseId: 'course-1', title: 'Exam', isSchedulable: true,
        cbtfDurationMinutes: duration,
        availableFrom: new Date('2030-01-01T00:00:00.000Z'),
        scheduleWindowStart: new Date('2030-01-01T00:00:00.000Z'),
        acceptUntil: new Date('2030-01-15T00:00:00.000Z'),
        scheduleWindowEnd: new Date('2030-01-15T00:00:00.000Z'),
        course: { label: 'CS101', title: 'Course' }
      }
    }

    function reservation(data: any) {
      return {
        id: 'res-duration', ...data,
        assignment: { title: 'Exam' },
        user: { firstName: 'Demo', lastName: 'User', studentId: '123', avatarUrl: null }
      } as any
    }

    describe('Automatic facility placement', () => {
      const facilities = [
        configuredFacility({ id: 'fac-a', name: 'Center A', timezone: 'UTC', totalSeats: 48, seatAllocationOrder: [2, 1] }),
        configuredFacility({ id: 'fac-b', name: 'Center B', timezone: 'UTC', totalSeats: 57 }, '08:00', '12:00')
      ]

      beforeEach(() => {
        vi.mocked(notifyCbtfScheduleFailure).mockResolvedValue(true)
        vi.spyOn(cbtfCanvas, 'syncCbtfReservationCanvasOverride').mockResolvedValue({} as any)
        vi.mocked(prisma.assignment.findUnique).mockResolvedValue(assignment(90) as any)
        mockFacilities(...facilities)
        vi.mocked(prisma.cbtfReservation.create).mockImplementation(async ({ data }: any) => reservation(data))
        vi.mocked(prisma.cbtfReservation.update).mockImplementation(async ({ data }: any) => reservation(data))
        vi.mocked(prisma.cbtfReservation.findUnique).mockResolvedValue({
          id: 'res-duration', facilityId: 'fac-a', userId: 'usr-1', status: 'SCHEDULED',
          assignment: assignment(90)
        } as any)
      })

      afterEach(() => vi.mocked(cbtfCanvas.syncCbtfReservationCanvasOverride).mockRestore())

      function request(time = startTime, facilityId?: string) {
        return mockEvent({ id: 'usr-1', globalRole: 'USER' }, {},
          { assignmentId, facilityId, startTime: time }, { id: 'res-duration' })
      }

      it('uses stable facility and seat ordering for ties, regardless of legacy facility input', async () => {
        const response = await reservationsPost(request(startTime, 'fac-b'))
        expect(response.data).toMatchObject({ facilityId: 'fac-a', seatNumber: 2, endTime: '2030-01-07T11:30:00.000Z' })
      })

      it('reschedules to the better facility and excludes the current reservation', async () => {
        vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValue([
          { facilityId: 'fac-a', seatNumber: 2, startTime: new Date(startTime), endTime: new Date('2030-01-07T11:30Z') }
        ] as any)
        const response = await reservationPatch(request())
        expect(response.data).toMatchObject({ facilityId: 'fac-b', seatNumber: 1 })
        expect(prisma.cbtfReservation.findMany).toHaveBeenCalledWith(expect.objectContaining({
          where: expect.objectContaining({ id: { not: 'res-duration' } })
        }))
      })

      it.each([['POST', reservationsPost], ['PATCH', reservationPatch]] as const)(
        '%s excludes facilities whose hours cannot fit the entire exam', async (_method, handler) => {
          await expect(handler(request('2030-01-07T11:00:00.000Z')))
            .resolves.toMatchObject({ data: { facilityId: 'fac-a' } })
          await expect(handler(request('2030-01-07T16:00:00.000Z')))
            .rejects.toMatchObject({ statusCode: 409 })
        }
      )

      it('rechecks availability after acquiring the facility locks before writing', async () => {
        const facility = configuredFacility({ id: 'fac-a', name: 'Center A', timezone: 'UTC', totalSeats: 1 })
        mockFacilities(facility)
        vi.mocked(prisma.$queryRaw).mockImplementation(async () => {
          vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValue([
            { facilityId: facility.id, seatNumber: 1, startTime: new Date('2030-01-07T09:55Z'), endTime: new Date('2030-01-07T11:25Z') }
          ] as any)
          return [{ id: facility.id }]
        })
        await expect(reservationsPost(request())).rejects.toMatchObject({ statusCode: 409 })
        expect(prisma.cbtfReservation.findMany).toHaveBeenCalledOnce()
        expect(prisma.cbtfReservation.create).not.toHaveBeenCalled()
      })
    })

    it.each([
      [90, 90], [240, 240], [null, 60]
    ])('POST persists the correct endTime for duration %s', async (duration, expectedMinutes) => {
      vi.mocked(prisma.assignment.findUnique).mockResolvedValue(assignment(duration) as any)
      vi.mocked(prisma.cbtfReservation.create).mockImplementation(async ({ data }: any) =>
        reservation(data)
      )
      const expectedEnd = new Date(new Date(startTime).getTime() + expectedMinutes! * 60 * 1000)

      const response = await reservationsPost(mockEvent(
        { id: 'usr-1', globalRole: 'USER' }, {}, { assignmentId, facilityId: 'fac-1', startTime }
      ))

      expect(response.statusCode).toBe(201)
      expect(prisma.cbtfReservation.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ facilityId: 'fac-1', startTime: new Date(startTime), endTime: expectedEnd })
      }))
      expect(response.data.endTime).toBe(expectedEnd.toISOString())
    })

    it('PATCH persists a new endTime 120 minutes after the new start', async () => {
      vi.mocked(prisma.cbtfReservation.findUnique).mockResolvedValue({
        id: 'res-duration', userId: 'usr-1', status: 'SCHEDULED',
        startTime: new Date('2030-01-06T10:00:00.000Z'),
        endTime: new Date('2030-01-06T12:00:00.000Z'),
        assignment: assignment(120)
      } as any)
      vi.mocked(prisma.cbtfReservation.update).mockImplementation(async ({ data }: any) =>
        reservation(data)
      )

      const response = await reservationPatch(mockEvent(
        { id: 'usr-1', globalRole: 'USER' }, {}, { facilityId: 'fac-1', startTime }, { id: 'res-duration' }
      ))

      expect(response.statusCode).toBe(200)
      expect(prisma.cbtfReservation.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'res-duration', status: 'SCHEDULED' },
        data: expect.objectContaining({
          startTime: new Date(startTime), endTime: new Date('2030-01-07T12:00:00.000Z')
        })
      }))
      expect(response.data.endTime).toBe('2030-01-07T12:00:00.000Z')
    })

    describe('SSD accommodations', () => {
      beforeEach(() => {
        vi.mocked(notifyCbtfScheduleFailure).mockResolvedValue(true)
        vi.spyOn(cbtfCanvas, 'syncCbtfReservationCanvasOverride').mockResolvedValue({} as any)
        vi.mocked(prisma.assignment.findUnique).mockResolvedValue(assignment(60) as any)
        vi.mocked(prisma.cbtfReservation.create).mockImplementation(async ({ data }: any) =>
          reservation(data)
        )
        vi.mocked(prisma.cbtfReservation.update).mockImplementation(async ({ data }: any) =>
          reservation(data)
        )
      })

      afterEach(() => vi.mocked(cbtfCanvas.syncCbtfReservationCanvasOverride).mockRestore())

      it('applies the extra-time multiplier when booking', async () => {
        vi.mocked(prisma.cbtfStudentAccommodation.findUnique).mockResolvedValue({
          timeMultiplier: 1.5,
          requiredSeatProperties: [],
          isActive: true
        } as any)

        const response = await reservationsPost(
          mockEvent({ id: 'usr-1', globalRole: 'USER' }, {}, {
            assignmentId,
            facilityId: 'fac-1',
            startTime
          })
        )

        expect(response.data.endTime).toBe('2030-01-07T11:30:00.000Z')
        expect(prisma.cbtfReservation.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ endTime: new Date('2030-01-07T11:30:00.000Z') })
          })
        )
      })

      it('assigns only seats certified for the student requirements', async () => {
        mockFacilities({ ...configuredFacility({
          id: 'fac-1',
          name: 'Testing Center',
          timezone: 'UTC',
          totalSeats: 3,
          seatAllocationOrder: [1, 2, 3]
        }), seats: [
          { seatNumber: 2, properties: ['SSD'] }
        ] })
        vi.mocked(prisma.cbtfStudentAccommodation.findUnique).mockResolvedValue({
          timeMultiplier: 1,
          requiredSeatProperties: ['SSD'],
          isActive: true
        } as any)

        const response = await reservationsPost(
          mockEvent({ id: 'usr-1', globalRole: 'USER' }, {}, {
            assignmentId,
            facilityId: 'fac-1',
            startTime
          })
        )

        expect(response.data.seatNumber).toBe(2)
        expect(prisma.cbtfReservation.create).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ seatNumber: 2 }) })
        )
      })

      it('keeps certified seats away from students without requirements', async () => {
        mockFacilities({ ...configuredFacility({
          id: 'fac-1',
          name: 'Testing Center',
          timezone: 'UTC',
          totalSeats: 2,
          seatAllocationOrder: [1, 2]
        }), seats: [
          { seatNumber: 1, properties: ['SSD'] }
        ] })

        const response = await reservationsPost(
          mockEvent({ id: 'usr-1', globalRole: 'USER' }, {}, {
            assignmentId,
            facilityId: 'fac-1',
            startTime
          })
        )

        expect(response.data.seatNumber).toBe(2)
      })

      it('rejects booking when no seat meets the accommodation', async () => {
        vi.mocked(prisma.cbtfStudentAccommodation.findUnique).mockResolvedValue({
          timeMultiplier: 1,
          requiredSeatProperties: ['SSD'],
          isActive: true
        } as any)

        await expect(
          reservationsPost(
            mockEvent({ id: 'usr-1', globalRole: 'USER' }, {}, {
              assignmentId,
              facilityId: 'fac-1',
              startTime
            })
          )
        ).rejects.toMatchObject({
          statusCode: 409,
          statusMessage: expect.stringContaining('No eligible workstation')
        })
      })

      it('applies the multiplier when rescheduling', async () => {
        vi.mocked(prisma.cbtfReservation.findUnique).mockResolvedValue({
          id: 'res-duration',
          userId: 'usr-1',
          status: 'SCHEDULED',
          startTime: new Date('2030-01-06T10:00:00.000Z'),
          endTime: new Date('2030-01-06T11:00:00.000Z'),
          assignment: assignment(60)
        } as any)
        vi.mocked(prisma.cbtfStudentAccommodation.findUnique).mockResolvedValue({
          timeMultiplier: 2,
          requiredSeatProperties: [],
          isActive: true
        } as any)

        const response = await reservationPatch(
          mockEvent({ id: 'usr-1', globalRole: 'USER' }, {}, { facilityId: 'fac-1', startTime }, {
            id: 'res-duration'
          })
        )

        expect(response.data.endTime).toBe('2030-01-07T12:00:00.000Z')
      })
    })
  })

})
