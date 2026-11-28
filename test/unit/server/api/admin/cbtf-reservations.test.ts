import { describe, it, expect, vi, beforeEach } from 'vitest'
import reservationsGet from '../../../../../server/api/admin/cbtf/reservations.get'
import reservationPatch from '../../../../../server/api/admin/cbtf/reservations/[id].patch'
import reservationDelete from '../../../../../server/api/admin/cbtf/reservations/[id].delete'
import prisma from '@@/server/utils/db'
import {
  syncCbtfReservationCanvasOverride,
  deleteCbtfReservationCanvasOverride
} from '@@/server/utils/cbtf-canvas'

vi.mock('@@/server/utils/db', () => {
  const db = {
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
    cbtfReservation: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      delete: vi.fn()
    },
    cbtfFacility: {
      findMany: vi.fn()
    },
    cbtfStudentAccommodation: {
      findUnique: vi.fn()
    }
  }

  db.$transaction.mockImplementation(async (callback) => callback(db))

  return { default: db }
})

vi.mock('@@/server/utils/cbtf-canvas', () => ({
  syncCbtfReservationCanvasOverride: vi
    .fn()
    .mockResolvedValue({ status: 'updated', overrideId: 'override-123' }),
  deleteCbtfReservationCanvasOverride: vi.fn().mockResolvedValue(true)
}))

vi.stubGlobal('getUserSession', (event: any) =>
  Promise.resolve({ user: event.context?.user || null })
)

vi.mock('h3', async () => {
  const actual = await vi.importActual('h3')
  return {
    ...actual,
    defineEventHandler: (handler: any) => handler,
    readBody: (event: any) => Promise.resolve(event._body || {}),
    getQuery: (event: any) => event._query || {},
    getRouterParam: (event: any, name: string) => event.context?.params?.[name] || null,
    createError: (opts: any) => {
      const err = new Error(opts.statusMessage || 'Error') as any
      err.statusCode = opts.statusCode || 500
      err.statusMessage = opts.statusMessage
      return err
    }
  }
})

describe('Admin CBTF Reservations Endpoints', () => {
  const mockEvent = (userRole: string | null = 'ADMIN', body = {}, params = {}, query = {}) =>
    ({
      context: {
        user: userRole ? { id: 'admin-1', globalRole: userRole } : null,
        params
      },
      node: { req: { method: 'GET' } },
      _body: body,
      _query: query
    }) as any

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('GET /api/admin/cbtf/reservations', () => {
    it('throws 401 if unauthenticated', async () => {
      const event = mockEvent(null)
      await expect(reservationsGet(event)).rejects.toThrow('Unauthorized')
    })

    it('throws 403 if not ADMIN', async () => {
      const event = mockEvent('STUDENT')
      await expect(reservationsGet(event)).rejects.toThrow('Forbidden')
    })

    it('defaults to next 50 upcoming reservations sorted asc by start time', async () => {
      const event = mockEvent('ADMIN')
      const mockList = [
        {
          id: 'res-1',
          facilityId: 'fac-1',
          assignmentId: 'asg-1',
          userId: 'usr-1',
          seatNumber: 12,
          startTime: new Date(Date.now() + 3600000),
          endTime: new Date(Date.now() + 7200000),
          status: 'SCHEDULED',
          canvasOverrideId: 'cov-1',
          assignment: { title: 'Exam 1' },
          user: {
            firstName: 'Alice',
            lastName: 'Smith',
            email: 'alice@vt.edu',
            studentId: '906111222',
            avatarUrl: null
          }
        }
      ]

      vi.mocked(prisma.cbtfReservation.count).mockResolvedValue(1)
      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValue(mockList as any)

      const res = await reservationsGet(event)

      expect(res.statusCode).toBe(200)
      expect(res.data?.length).toBe(1)
      expect(res.data?.[0].studentEmail).toBe('alice@vt.edu')
      expect(res.pagination).toEqual({
        total: 1,
        page: 1,
        pageSize: 50,
        totalPages: 1
      })

      // Verify Prisma query was called with upcoming startTime filter and take 50
      expect(prisma.cbtfReservation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 50,
          skip: 0,
          orderBy: { startTime: 'asc' },
          where: expect.objectContaining({
            startTime: expect.objectContaining({
              gte: expect.any(Date)
            })
          })
        })
      )
    })

    it('filters by search term (student name, email, student ID)', async () => {
      const event = mockEvent('ADMIN', {}, {}, { search: 'Smith' })
      vi.mocked(prisma.cbtfReservation.count).mockResolvedValue(1)
      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValue([])

      await reservationsGet(event)

      expect(prisma.cbtfReservation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            user: {
              OR: [
                { firstName: { contains: 'Smith', mode: 'insensitive' } },
                { lastName: { contains: 'Smith', mode: 'insensitive' } },
                { email: { contains: 'Smith', mode: 'insensitive' } },
                { studentId: { contains: 'Smith', mode: 'insensitive' } }
              ]
            }
          })
        })
      )
    })

    it('filters by status and custom date range with pagination', async () => {
      const event = mockEvent(
        'ADMIN',
        {},
        {},
        {
          status: 'CHECKED_IN',
          from: '2026-10-01T00:00:00.000Z',
          to: '2026-10-02T23:59:59.000Z',
          page: '2',
          pageSize: '25'
        }
      )

      vi.mocked(prisma.cbtfReservation.count).mockResolvedValue(60)
      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValue([])

      const res = await reservationsGet(event)

      expect(res.pagination).toEqual({
        total: 60,
        page: 2,
        pageSize: 25,
        totalPages: 3
      })

      expect(prisma.cbtfReservation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 25,
          skip: 25,
          where: expect.objectContaining({
            status: 'CHECKED_IN',
            startTime: {
              gte: new Date('2026-10-01T00:00:00.000Z'),
              lte: new Date('2026-10-02T23:59:59.000Z')
            }
          })
        })
      )
    })
  })

  describe('PATCH /api/admin/cbtf/reservations/[id]', () => {
    const existingReservation = {
      id: 'res-1',
      facilityId: 'fac-1',
      userId: 'usr-1',
      seatNumber: 10,
      startTime: new Date('2026-10-10T13:00:00.000Z'),
      endTime: new Date('2026-10-10T14:00:00.000Z'),
      status: 'SCHEDULED'
    }

    const facility = {
      id: 'fac-1',
      name: 'Testing Center',
      totalSeats: 48,
      timezone: 'UTC',
      spareSeatCount: 4,
      operatingHours: [
        {
          dayOfWeek: 6,
          openTime: '08:00',
          closeTime: '18:00'
        }
      ],
      scheduleExceptions: [],
      seats: [],
      seatStatuses: []
    }

    const editEvent = (body: Record<string, unknown>) => mockEvent('ADMIN', body, { id: 'res-1' })

    beforeEach(() => {
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ id: 'fac-1' }])
      vi.mocked(prisma.cbtfReservation.findUnique).mockResolvedValue(existingReservation as any)
      vi.mocked(prisma.cbtfReservation.findFirst).mockResolvedValue(null)
      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValue([])
      vi.mocked(prisma.cbtfFacility.findMany).mockResolvedValue([facility] as any)
      vi.mocked(prisma.cbtfStudentAccommodation.findUnique).mockResolvedValue(null)

      vi.mocked(prisma.cbtfReservation.update).mockImplementation((async (args: any) => ({
        ...existingReservation,
        ...args.data,
        assignment: { title: 'Exam 1' },
        user: {
          firstName: 'Alice',
          lastName: 'Smith',
          email: 'alice@vt.edu'
        }
      })) as any)
    })

    const expectRejected = async (body: Record<string, unknown>, statusCode = 409) => {
      await expect(reservationPatch(editEvent(body))).rejects.toMatchObject({ statusCode })

      expect(prisma.cbtfReservation.update).not.toHaveBeenCalled()

      expect(syncCbtfReservationCanvasOverride).not.toHaveBeenCalled()

      expect(deleteCbtfReservationCanvasOverride).not.toHaveBeenCalled()
    }

    it('throws 404 if reservation does not exist', async () => {
      vi.mocked(prisma.cbtfReservation.findUnique).mockResolvedValue(null)

      await expect(reservationPatch(editEvent({ status: 'CHECKED_IN' }))).rejects.toMatchObject({
        statusCode: 404
      })
    })

    it('updates a valid time slot and seat and invokes Canvas sync', async () => {
      const result = await reservationPatch(
        editEvent({
          seatNumber: 15,
          startTime: '2026-10-10T14:00:00.000Z',
          endTime: '2026-10-10T15:00:00.000Z'
        })
      )

      expect(result.statusCode).toBe(200)

      expect(prisma.cbtfReservation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'res-1',
            status: 'SCHEDULED',
            facilityId: 'fac-1',
            seatNumber: 10
          },
          data: expect.objectContaining({
            seatNumber: 15,
            startTime: new Date('2026-10-10T14:00:00.000Z'),
            endTime: new Date('2026-10-10T15:00:00.000Z')
          })
        })
      )

      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: 'ReadCommitted'
      })

      expect(prisma.$queryRaw).toHaveBeenCalled()

      expect(syncCbtfReservationCanvasOverride).toHaveBeenCalledWith('res-1')
    })

    it('rejects a seat outside the facility capacity', async () => {
      await expectRejected({ seatNumber: 49 })
    })

    it('rejects a spare seat during normal reservation editing', async () => {
      await expectRejected({ seatNumber: 48 })
    })

    it('rejects an out-of-service seat', async () => {
      vi.mocked(prisma.cbtfFacility.findMany).mockResolvedValue([
        {
          ...facility,
          seatStatuses: [{ seatNumber: 15, isDisabled: true }]
        }
      ] as any)

      await expectRejected({ seatNumber: 15 })
    })

    it('rejects an occupied seat instead of choosing another seat', async () => {
      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValue([
        {
          facilityId: 'fac-1',
          seatNumber: 15,
          startTime: new Date('2026-10-10T13:30:00.000Z'),
          endTime: new Date('2026-10-10T14:30:00.000Z')
        }
      ] as any)

      await expectRejected({ seatNumber: 15 })
    })

    it('rejects a seat that does not satisfy SSD requirements', async () => {
      vi.mocked(prisma.cbtfStudentAccommodation.findUnique).mockResolvedValue({
        isActive: true,
        timeMultiplier: 1,
        requiredSeatProperties: ['ACCESSIBLE']
      } as any)

      await expectRejected({ seatNumber: 15 })
    })

    it('rejects a reservation outside facility operating hours', async () => {
      await expectRejected({
        startTime: '2026-10-10T18:00:00.000Z',
        endTime: '2026-10-10T19:00:00.000Z'
      })
    })

    it('rejects a reservation on a closed exception date', async () => {
      vi.mocked(prisma.cbtfFacility.findMany).mockResolvedValue([
        {
          ...facility,
          scheduleExceptions: [
            {
              date: new Date('2026-10-10T00:00:00.000Z'),
              isClosed: true,
              openTime: null,
              closeTime: null,
              reason: 'Scheduled Closure'
            }
          ]
        }
      ] as any)

      await expectRejected({ seatNumber: 15 })
    })

    it('rejects changes exceeding the arrival limit', async () => {
      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValue(
        Array.from({ length: 4 }, (_, index) => ({
          facilityId: 'fac-1',
          seatNumber: index + 1,
          startTime: existingReservation.startTime,
          endTime: existingReservation.endTime
        })) as any
      )

      await expectRejected({ seatNumber: 15 })
    })

    it('rejects overlapping reservations for the same student', async () => {
      vi.mocked(prisma.cbtfReservation.findFirst).mockResolvedValue({ id: 'res-2' } as any)

      await expectRejected({ seatNumber: 15 })
    })

    it('rejects an invalid interval when only endTime changes', async () => {
      await expectRejected(
        {
          endTime: '2026-10-10T12:00:00.000Z'
        },
        400
      )
    })

    it('validates placement when reactivating a cancelled reservation', async () => {
      vi.mocked(prisma.cbtfReservation.findUnique).mockResolvedValue({
        ...existingReservation,
        status: 'CANCELLED'
      } as any)

      vi.mocked(prisma.cbtfReservation.findFirst).mockResolvedValue({ id: 'res-2' } as any)

      await expectRejected({ status: 'SCHEDULED' })
    })

    it('allows cancellation without revalidating placement', async () => {
      const result = await reservationPatch(editEvent({ status: 'CANCELLED' }))

      expect(result.statusCode).toBe(200)

      expect(prisma.cbtfFacility.findMany).not.toHaveBeenCalled()

      expect(deleteCbtfReservationCanvasOverride).toHaveBeenCalledWith('res-1')
    })

    it('allows checkout without revalidating placement', async () => {
      vi.mocked(prisma.cbtfReservation.findUnique).mockResolvedValue({
        ...existingReservation,
        status: 'CHECKED_IN'
      } as any)

      const result = await reservationPatch(editEvent({ status: 'CHECKED_OUT' }))

      expect(result.statusCode).toBe(200)

      expect(prisma.cbtfFacility.findMany).not.toHaveBeenCalled()

      expect(prisma.cbtfReservation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'CHECKED_OUT',
            checkedOutAt: expect.any(Date),
            checkedOutByUserId: 'admin-1'
          })
        })
      )
    })

    it('returns conflict when the reservation changes concurrently', async () => {
      vi.mocked(prisma.cbtfReservation.update).mockRejectedValueOnce({ code: 'P2025' })

      await expect(reservationPatch(editEvent({ seatNumber: 15 }))).rejects.toMatchObject({
        statusCode: 409
      })

      expect(syncCbtfReservationCanvasOverride).not.toHaveBeenCalled()
    })
  })

  describe('DELETE /api/admin/cbtf/reservations/[id]', () => {
    it('throws 401 if unauthenticated', async () => {
      const event = mockEvent(null, {}, { id: 'res-1' })
      await expect(reservationDelete(event)).rejects.toThrow('Unauthorized')
    })

    it('throws 403 if not ADMIN', async () => {
      const event = mockEvent('TEACHER', {}, { id: 'res-1' })
      await expect(reservationDelete(event)).rejects.toThrow('Forbidden')
    })

    it('throws 404 if reservation does not exist', async () => {
      const event = mockEvent('ADMIN', {}, { id: 'res-missing' })
      vi.mocked(prisma.cbtfReservation.findUnique).mockResolvedValue(null)

      await expect(reservationDelete(event)).rejects.toThrow('Reservation not found')
    })

    it('preserves a pass-backed retake and its redemption claim', async () => {
      vi.mocked(prisma.cbtfReservation.findUnique).mockResolvedValue({
        id: 'retake', retakeRedemptionId: 'redeemed-pass', status: 'CHECKED_OUT'
      } as any)

      await expect(reservationDelete(mockEvent('ADMIN', {}, { id: 'retake' }))).rejects.toMatchObject({
        statusCode: 409
      })
      expect(deleteCbtfReservationCanvasOverride).not.toHaveBeenCalled()
      expect(prisma.cbtfReservation.delete).not.toHaveBeenCalled()
    })

    it('deletes Canvas override before deleting reservation record', async () => {
      const event = mockEvent('ADMIN', {}, { id: 'res-1' })

      vi.mocked(prisma.cbtfReservation.findUnique).mockResolvedValue({
        id: 'res-1',
        canvasOverrideId: 'cov-99'
      } as any)

      vi.mocked(prisma.cbtfReservation.delete).mockResolvedValue({
        id: 'res-1'
      } as any)

      const res = await reservationDelete(event)

      expect(res.statusCode).toBe(200)
      expect(deleteCbtfReservationCanvasOverride).toHaveBeenCalledWith('res-1')
      expect(prisma.cbtfReservation.delete).toHaveBeenCalledWith({
        where: { id: 'res-1', AND: [{ retakeRedemptionId: null }] }
      })
    })
  })
})
