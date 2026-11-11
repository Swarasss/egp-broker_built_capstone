import { describe, it, expect, vi, beforeEach } from 'vitest'
import facilityGet from '../../../../../server/api/admin/cbtf/facility.get'
import facilityPatch from '../../../../../server/api/admin/cbtf/facility.patch'
import facilityPost from '../../../../../server/api/admin/cbtf/facility.post'
import facilityDelete from '../../../../../server/api/admin/cbtf/facility/[id].delete'
import operatingHoursPost from '../../../../../server/api/admin/cbtf/operating-hours.post'
import operatingHoursDelete from '../../../../../server/api/admin/cbtf/operating-hours/[id].delete'
import exceptionsPost from '../../../../../server/api/admin/cbtf/exceptions.post'
import exceptionsDelete from '../../../../../server/api/admin/cbtf/exceptions/[id].delete'
import shiftsGet from '../../../../../server/api/admin/cbtf/shifts.get'
import shiftsPost from '../../../../../server/api/admin/cbtf/shifts.post'
import shiftsDelete from '../../../../../server/api/admin/cbtf/shifts/[id].delete'
import shiftsBatchPost from '../../../../../server/api/admin/cbtf/shifts/batch.post'
import shiftPatch from '../../../../../server/api/admin/cbtf/shifts/[id].patch'
import reservationsGet from '../../../../../server/api/admin/cbtf/reservations.get'
import reservationPatch from '../../../../../server/api/admin/cbtf/reservations/[id].patch'
import prisma from '@@/server/utils/db'

vi.mock('@@/server/utils/db', () => ({
  default: {
    $transaction: vi.fn((promises: any[]) => Promise.all(promises)),
    $queryRaw: vi.fn(),
    cbtfFacility: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(),
      create: vi.fn()
    },
    cbtfOperatingHours: {
      upsert: vi.fn(),
      delete: vi.fn()
    },
    cbtfScheduleException: {
      create: vi.fn(),
      delete: vi.fn()
    },
    cbtfProctorShift: {
      count: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn()
    },
    cbtfReservation: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      update: vi.fn()
    }
  }
}))

vi.mock('@@/server/utils/cbtf-canvas', () => ({
  syncCbtfReservationCanvasOverride: vi.fn().mockResolvedValue({ status: 'updated' }),
  deleteCbtfReservationCanvasOverride: vi.fn().mockResolvedValue(true)
}))

vi.stubGlobal('getUserSession', (event: any) =>
  Promise.resolve({ user: event.context?.user || null })
)

describe('API: Admin CBTF Endpoints', () => {
  const mockEvent = (userRole: string | null = 'ADMIN', body = {}, params = {}) =>
    ({
      context: {
        user: userRole ? { id: 'admin-1', globalRole: userRole } : null,
        params
      },
      node: { req: { method: 'GET' } },
      _body: body
    }) as any

  vi.mock('h3', async () => {
    const actual = await vi.importActual('h3')
    return {
      ...actual,
      defineEventHandler: (handler: any) => handler,
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
    vi.clearAllMocks()
  })

  describe('Facility Settings', () => {
    it('throws 403 if user is not admin', async () => {
      const event = mockEvent('USER')
      await expect(facilityGet(event)).rejects.toThrowError(
        expect.objectContaining({ statusCode: 403 })
      )
    })

    it('returns all facilities for admin', async () => {
      const event = mockEvent('ADMIN')
      const mockFacility = {
        id: 'fac-1',
        name: 'Main Facility',
        totalSeats: 48,
        seatAllocationOrder: [1, 2, 3],
        operatingHours: [],
        scheduleExceptions: []
      }
      vi.mocked(prisma.cbtfFacility.findMany).mockResolvedValue([mockFacility, { ...mockFacility, id: 'fac-2' }] as any)

      const res = await facilityGet(event)
      expect(res.statusCode).toBe(200)
      expect(res.data.map((facility: any) => facility.id)).toEqual(['fac-1', 'fac-2'])
    })

    it('updates facility seats and custom allocation order', async () => {
      const event = mockEvent('ADMIN', {
        facilityId: 'fac-2',
        name: 'Updated Facility',
        totalSeats: 24,
        seatAllocationOrder: [1, 13, 2, 14]
      })

      vi.mocked(prisma.cbtfFacility.findUnique).mockResolvedValue({ id: 'fac-2' } as any)
      vi.mocked(prisma.cbtfFacility.update).mockResolvedValue({
        id: 'fac-1',
        name: 'Updated Facility',
        totalSeats: 24,
        seatAllocationOrder: [1, 13, 2, 14],
        operatingHours: [],
        scheduleExceptions: []
      } as any)

      const res = await facilityPatch(event)
      expect(res.statusCode).toBe(200)
      expect(prisma.cbtfFacility.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'fac-2' },
          data: expect.objectContaining({
            totalSeats: 24,
            seatAllocationOrder: [1, 13, 2, 14]
          })
        })
      )
    })
  })

  describe('Multi-facility management', () => {
    it('returns an empty list without creating a default facility', async () => {
      vi.mocked(prisma.cbtfFacility.findMany).mockResolvedValue([])
      expect((await facilityGet(mockEvent())).data).toEqual([])
      expect(prisma.cbtfFacility.create).not.toHaveBeenCalled()
    })

    it.each([facilityGet, facilityPost, facilityPatch, facilityDelete])(
      'requires an authenticated administrator', async (handler) => {
        await expect(handler(mockEvent(null))).rejects.toMatchObject({ statusCode: 401 })
        await expect(handler(mockEvent('USER'))).rejects.toMatchObject({ statusCode: 403 })
      }
    )

    it('creates a facility with a default seat order', async () => {
      vi.mocked(prisma.cbtfFacility.create).mockResolvedValue({ id: 'fac-new' } as any)
      const result = await facilityPost(mockEvent('ADMIN', { name: 'Room Two', totalSeats: 3 }))
      expect(result).toMatchObject({ statusCode: 201, data: { id: 'fac-new' } })
      expect(prisma.cbtfFacility.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ name: 'Room Two', totalSeats: 3, seatAllocationOrder: [1, 2, 3] })
      }))
    })

    it('rejects invalid facility creation', async () => {
      await expect(facilityPost(mockEvent('ADMIN', { name: '', totalSeats: 0 })))
        .rejects.toMatchObject({ statusCode: 400 })
      expect(prisma.cbtfFacility.create).not.toHaveBeenCalled()
    })

    it('requires an explicit facility ID for updates', async () => {
      await expect(facilityPatch(mockEvent('ADMIN', { name: 'Room' })))
        .rejects.toMatchObject({ statusCode: 400 })
      expect(prisma.cbtfFacility.update).not.toHaveBeenCalled()
    })

    it('returns 404 for an unknown update target', async () => {
      vi.mocked(prisma.cbtfFacility.findUnique).mockResolvedValue(null)
      await expect(facilityPatch(mockEvent('ADMIN', { facilityId: 'missing', name: 'Room' })))
        .rejects.toMatchObject({ statusCode: 404 })
    })

    const prepareDeletion = (exists = true, reservations = 0, shifts = 0) => {
      vi.mocked(prisma.$transaction).mockImplementationOnce(async (callback: any) => callback(prisma))
      vi.mocked(prisma.$queryRaw).mockResolvedValue(exists ? [{ id: 'fac-2' }] : [])
      vi.mocked(prisma.cbtfReservation.count).mockResolvedValue(reservations)
      vi.mocked(prisma.cbtfProctorShift.count).mockResolvedValue(shifts)
    }

    it('deletes an unused facility', async () => {
      prepareDeletion()
      const result = await facilityDelete(mockEvent('ADMIN', {}, { id: 'fac-2' }))
      expect(result.statusCode).toBe(200)
      expect(prisma.cbtfFacility.delete).toHaveBeenCalledWith({ where: { id: 'fac-2' } })
    })

    it.each([[1, 0], [0, 1]])('blocks deletion with reservations=%i shifts=%i', async (reservations, shifts) => {
      prepareDeletion(true, reservations, shifts)
      await expect(facilityDelete(mockEvent('ADMIN', {}, { id: 'fac-2' })))
        .rejects.toMatchObject({ statusCode: 409 })
      expect(prisma.cbtfFacility.delete).not.toHaveBeenCalled()
    })

    it('returns 404 for an unknown delete target', async () => {
      prepareDeletion(false)
      await expect(facilityDelete(mockEvent('ADMIN', {}, { id: 'missing' })))
        .rejects.toMatchObject({ statusCode: 404 })
      expect(prisma.cbtfFacility.delete).not.toHaveBeenCalled()
    })
  })

  describe('Operating Hours', () => {
    it('upserts operating hours for a day of week', async () => {
      const event = mockEvent('ADMIN', {
        facilityId: 'fac-1',
        dayOfWeek: 1,
        openTime: '08:00',
        closeTime: '18:00'
      })

      vi.mocked(prisma.cbtfOperatingHours.upsert).mockResolvedValue({
        id: 'oh-1',
        facilityId: 'fac-1',
        dayOfWeek: 1,
        openTime: '08:00',
        closeTime: '18:00'
      } as any)

      const res = await operatingHoursPost(event)
      expect(res.statusCode).toBe(200)
      expect(prisma.cbtfOperatingHours.upsert).toHaveBeenCalled()
    })

    it('deletes operating hours entry', async () => {
      const event = mockEvent('ADMIN', {}, { id: 'oh-1' })
      vi.mocked(prisma.cbtfOperatingHours.delete).mockResolvedValue({ id: 'oh-1' } as any)

      const res = await operatingHoursDelete(event)
      expect(res.statusCode).toBe(200)
      expect(prisma.cbtfOperatingHours.delete).toHaveBeenCalledWith({ where: { id: 'oh-1' } })
    })
  })

  describe('Schedule Exceptions', () => {
    it('creates schedule exception with isClosed: true', async () => {
      const event = mockEvent('ADMIN', {
        facilityId: 'fac-1',
        date: '2026-11-26',
        isClosed: true,
        reason: 'Thanksgiving'
      })

      vi.mocked(prisma.cbtfScheduleException.create).mockResolvedValue({
        id: 'ex-1',
        facilityId: 'fac-1',
        date: new Date('2026-11-26T00:00:00.000Z'),
        isClosed: true,
        reason: 'Thanksgiving'
      } as any)

      const res = await exceptionsPost(event)
      expect(res.statusCode).toBe(201)
      expect(prisma.cbtfScheduleException.create).toHaveBeenCalled()
    })

    it('deletes schedule exception', async () => {
      const event = mockEvent('ADMIN', {}, { id: 'ex-1' })
      vi.mocked(prisma.cbtfScheduleException.delete).mockResolvedValue({ id: 'ex-1' } as any)

      const res = await exceptionsDelete(event)
      expect(res.statusCode).toBe(200)
      expect(prisma.cbtfScheduleException.delete).toHaveBeenCalledWith({ where: { id: 'ex-1' } })
    })
  })

  describe('Proctor Shifts', () => {
    it('fetches all proctor shifts', async () => {
      const event = mockEvent('ADMIN')
      vi.mocked(prisma.cbtfProctorShift.findMany).mockResolvedValue([
        {
          id: 'shift-1',
          userId: 'usr-p1',
          startTime: new Date('2026-10-05T08:00:00.000Z'),
          endTime: new Date('2026-10-05T12:00:00.000Z'),
          user: { firstName: 'Proctor', lastName: 'User', email: 'proctor@example.com' },
          facility: { name: 'Main Testing Center' }
        }
      ] as any)

      const res = await shiftsGet(event)
      expect(res.statusCode).toBe(200)
      expect(res.data.length).toBe(1)
    })

    it('creates proctor shift', async () => {
      const event = mockEvent('ADMIN', {
        facilityId: 'fac-1',
        userId: 'usr-p1',
        startTime: '2026-10-05T08:00:00.000Z',
        endTime: '2026-10-05T12:00:00.000Z'
      })

      vi.mocked(prisma.cbtfProctorShift.create).mockResolvedValue({
        id: 'shift-1',
        facilityId: 'fac-1',
        userId: 'usr-p1',
        date: new Date('2026-10-05T00:00:00.000Z'),
        startTime: '08:00',
        endTime: '12:00'
      } as any)

      const res = await shiftsPost(event)
      expect(res.statusCode).toBe(201)
      expect(prisma.cbtfProctorShift.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            facilityId: 'fac-1',
            userId: 'usr-p1',
            date: new Date('2026-10-05T00:00:00.000Z'),
            startTime: '08:00',
            endTime: '12:00'
          })
        })
      )
    })

    it('deletes proctor shift', async () => {
      const event = mockEvent('ADMIN', {}, { id: 'shift-1' })
      vi.mocked(prisma.cbtfProctorShift.delete).mockResolvedValue({ id: 'shift-1' } as any)

      const res = await shiftsDelete(event)
      expect(res.statusCode).toBe(200)
      expect(prisma.cbtfProctorShift.delete).toHaveBeenCalledWith({ where: { id: 'shift-1' } })
    })

    it('batch generates proctor shifts across date range', async () => {
      const event = mockEvent('ADMIN', {
        facilityId: 'fac-1',
        userId: 'usr-p1',
        startDate: '2026-09-14', // Monday
        endDate: '2026-09-20', // Sunday
        shifts: [
          { dayOfWeek: 1, startTime: '14:00', endTime: '17:00' }, // Monday
          { dayOfWeek: 3, startTime: '09:00', endTime: '11:30' } // Wednesday
        ]
      })

      vi.mocked(prisma.cbtfProctorShift.create).mockResolvedValue({
        id: 'shift-generated',
        facilityId: 'fac-1',
        userId: 'usr-p1',
        date: new Date('2026-09-14T00:00:00.000Z'),
        startTime: '14:00',
        endTime: '17:00'
      } as any)

      const res = await shiftsBatchPost(event)
      expect(res.statusCode).toBe(201)
      expect(res.data.count).toBe(2)
      expect(prisma.cbtfProctorShift.create).toHaveBeenCalledTimes(2)
      expect(prisma.cbtfProctorShift.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            facilityId: 'fac-1',
            userId: 'usr-p1',
            date: new Date('2026-09-14T00:00:00.000Z'),
            startTime: '14:00',
            endTime: '17:00'
          }
        })
      )
    })

    it('updates a specific proctor shift (single timeslot adjustment or reassignment)', async () => {
      const event = mockEvent(
        'ADMIN',
        {
          userId: 'usr-substitute',
          startTime: '2026-09-14T14:30:00.000Z',
          endTime: '2026-09-14T17:00:00.000Z'
        },
        { id: 'shift-1' }
      )

      vi.mocked(prisma.cbtfProctorShift.findUnique).mockResolvedValue({
        id: 'shift-1',
        userId: 'usr-p1'
      } as any)

      vi.mocked(prisma.cbtfProctorShift.update).mockResolvedValue({
        id: 'shift-1',
        userId: 'usr-substitute',
        date: new Date('2026-09-14T00:00:00.000Z'),
        startTime: '14:30',
        endTime: '17:00'
      } as any)

      const res = await shiftPatch(event)
      expect(res.statusCode).toBe(200)
      expect(res.data.userId).toBe('usr-substitute')
      expect(prisma.cbtfProctorShift.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'shift-1' },
          data: expect.objectContaining({
            userId: 'usr-substitute',
            date: new Date('2026-09-14T00:00:00.000Z'),
            startTime: '14:30',
            endTime: '17:00'
          })
        })
      )
    })
  })

  describe('Reservations Audit & Management', () => {
    it('fetches reservations audit log', async () => {
      const event = mockEvent('ADMIN')
      vi.mocked(prisma.cbtfReservation.count).mockResolvedValue(1)
      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValue([
        {
          id: 'res-1',
          facilityId: 'fac-1',
          assignmentId: 'asg-1',
          userId: 'usr-1',
          seatNumber: 10,
          startTime: new Date('2026-10-05T09:00:00.000Z'),
          endTime: new Date('2026-10-05T10:00:00.000Z'),
          status: 'SCHEDULED',
          assignment: { title: 'Midterm 1' },
          user: { firstName: 'Student', lastName: 'One', studentId: '906000001', avatarUrl: null }
        }
      ] as any)

      const res = await reservationsGet(event)
      expect(res.statusCode).toBe(200)
      expect(res.data.length).toBe(1)
      expect(res.data[0].seatNumber).toBe(10)
    })

    it('updates reservation status', async () => {
      const event = mockEvent('ADMIN', { status: 'CANCELLED' }, { id: 'res-1' })
      vi.mocked(prisma.cbtfReservation.findUnique).mockResolvedValue({
        id: 'res-1',
        status: 'SCHEDULED'
      } as any)
      vi.mocked(prisma.cbtfReservation.update).mockResolvedValue({
        id: 'res-1',
        facilityId: 'fac-1',
        assignmentId: 'asg-1',
        userId: 'usr-1',
        seatNumber: 10,
        startTime: new Date('2026-10-05T09:00:00.000Z'),
        endTime: new Date('2026-10-05T10:00:00.000Z'),
        status: 'CANCELLED',
        assignment: { title: 'Midterm 1' },
        user: { firstName: 'Student', lastName: 'One', studentId: '906000001', avatarUrl: null }
      } as any)

      const res = await reservationPatch(event)
      expect(res.statusCode).toBe(200)
      expect(res.data.status).toBe('CANCELLED')
    })
  })
})
