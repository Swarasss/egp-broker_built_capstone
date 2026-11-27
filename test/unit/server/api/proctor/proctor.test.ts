import { describe, it, expect, vi, beforeEach } from 'vitest'
import statusGet from '../../../../../server/api/proctor/status.get'
import statusPatch from '../../../../../server/api/proctor/status.patch'
import facilitiesGet from '../../../../../server/api/proctor/facilities.get'
import feedGet from '../../../../../server/api/proctor/feed.get'
import lookupGet from '../../../../../server/api/proctor/lookup.get'
import checkInPost from '../../../../../server/api/proctor/check-in.post'
import checkOutPost from '../../../../../server/api/proctor/check-out.post'
import prisma from '@@/server/utils/db'

vi.mock('@@/server/utils/db', () => ({
  default: {
    cbtfFacility: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn()
    },
    cbtfReservation: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn()
    },
    user: {
      findFirst: vi.fn()
    },
    cbtfReservationNote: {
      count: vi.fn().mockResolvedValue(0)
    },
    cbtfSeatStatus: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null)
    }
  }
}))

let currentSessionUser: any = null
vi.stubGlobal('getUserSession', () => Promise.resolve({ user: currentSessionUser }))
vi.stubGlobal('setUserSession', (_event: any, newSession: any) => {
  currentSessionUser = newSession.user
  return Promise.resolve()
})

describe('API: Proctor Operations Endpoints', () => {
  const mockEvent = (userRole: string | null = 'PROCTOR', query = {}, body = {}) =>
    ({
      context: {
        user: userRole
          ? { id: 'proctor-1', firstName: 'Proctor', lastName: 'User', globalRole: userRole }
          : null
      },
      node: {
        req: { method: 'GET' },
        res: { setHeader: vi.fn(), getHeader: vi.fn() }
      },
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
      createError: (opts: any) => {
        const err = new Error(opts.statusMessage || 'Error')
        Object.assign(err, opts)
        return err
      }
    }
  })

  beforeEach(() => {
    vi.clearAllMocks()
    currentSessionUser = { id: 'proctor-1', globalRole: 'PROCTOR', isOnDuty: false }
  })

  describe('Authorization', () => {
    it('rejects unauthenticated user with 401', async () => {
      currentSessionUser = null
      const event = mockEvent(null)
      await expect(statusGet(event)).rejects.toThrowError(
        expect.objectContaining({ statusCode: 401 })
      )
    })

    it('rejects student (USER) with 403', async () => {
      currentSessionUser = { id: 'usr-1', globalRole: 'USER' }
      const event = mockEvent('USER')
      await expect(feedGet(event)).rejects.toThrowError(
        expect.objectContaining({ statusCode: 403 })
      )
    })

    it('allows ADMIN to access proctor endpoints', async () => {
      currentSessionUser = { id: 'admin-1', globalRole: 'ADMIN' }
      const event = mockEvent('ADMIN')
      const res = await statusGet(event)
      expect(res.statusCode).toBe(200)
    })
  })

  describe('Duty Status', () => {
    it('gets duty status', async () => {
      currentSessionUser = { id: 'proctor-1', globalRole: 'PROCTOR', isOnDuty: true }
      const event = mockEvent('PROCTOR')
      const res = await statusGet(event)
      expect(res.data.isOnDuty).toBe(true)
    })

    it('toggles duty status', async () => {
      currentSessionUser = { id: 'proctor-1', globalRole: 'PROCTOR', isOnDuty: false }
      const event = mockEvent('PROCTOR', {}, { isOnDuty: true })
      const res = await statusPatch(event)
      expect(res.data.isOnDuty).toBe(true)
      expect(currentSessionUser.isOnDuty).toBe(true)
    })
  })

  describe('Live Feed', () => {
    it('lists all configured facilities and returns an empty feed without a valid selection', async () => {
      const facilities = [
        { id: 'fac-a', name: 'Facility A', timezone: 'UTC', totalSeats: 30 },
        { id: 'fac-b', name: 'Facility B', timezone: 'UTC', totalSeats: 40 }
      ]
      vi.mocked(prisma.cbtfFacility.findMany).mockResolvedValue(facilities as any)
      expect((await facilitiesGet(mockEvent())).data).toEqual(facilities)
      expect(prisma.cbtfFacility.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: { id: true, name: true, timezone: true, totalSeats: true }
        })
      )

      expect((await feedGet(mockEvent())).data).toBeNull()
      expect(prisma.cbtfFacility.findUnique).not.toHaveBeenCalled()
      vi.mocked(prisma.cbtfFacility.findUnique).mockResolvedValueOnce(null)
      expect((await feedGet(mockEvent('PROCTOR', { facilityId: 'removed' }))).data).toBeNull()
      expect(prisma.cbtfFacility.findFirst).not.toHaveBeenCalled()
      expect(prisma.cbtfReservation.findMany).not.toHaveBeenCalled()
    })

    it('switches rosters using the selected facility ID even for matching seat numbers', async () => {
      vi.mocked(prisma.cbtfFacility.findUnique).mockImplementation(
        async ({ where }) =>
          ({
            id: where.id,
            name: where.id === 'fac-a' ? 'Facility A' : 'Facility B',
            totalSeats: 40
          }) as any
      )
      vi.mocked(prisma.cbtfReservation.findMany).mockImplementation(
        async ({ where } = {}) =>
          [
            {
              id: `res-${where?.facilityId}`,
              facilityId: where?.facilityId,
              seatNumber: 6,
              status: 'CHECKED_IN',
              startTime: new Date(),
              endTime: new Date(),
              facility: { name: where?.facilityId === 'fac-a' ? 'Facility A' : 'Facility B' }
            }
          ] as any
      )

      for (const [facilityId, facilityName] of [
        ['fac-a', 'Facility A'],
        ['fac-b', 'Facility B']
      ]) {
        const { data } = await feedGet(mockEvent('PROCTOR', { facilityId }))
        expect(data.facility.id).toBe(facilityId)
        expect(data.seated).toMatchObject([
          { id: `res-${facilityId}`, facilityId, facilityName, seatNumber: 6 }
        ])
        expect(prisma.cbtfReservation.findMany).toHaveBeenLastCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ facilityId })
          })
        )
      }
    })

    it('classifies departures and sorts pending ends and completed checkouts independently', async () => {
      const now = Date.now()
      const at = (minutes: number) => new Date(now + minutes * 60000)
      const reservation = (id: string, end: number, checkout?: number) => ({
        id,
        facilityId: 'fac-1',
        startTime: at(end - 60),
        endTime: at(end),
        status: checkout === undefined ? 'CHECKED_IN' : 'CHECKED_OUT',
        checkedOutAt: checkout === undefined ? null : at(checkout)
      })
      vi.mocked(prisma.cbtfFacility.findUnique).mockResolvedValue({
        id: 'fac-1',
        name: 'Facility',
        totalSeats: 48,
        timezone: 'America/Los_Angeles'
      } as any)
      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValue([
        reservation('ending-soon', 5),
        reservation('old-checkout-with-later-scheduled-end', 30, -10),
        reservation('overdue', -5),
        reservation('newest-checkout', -10, -2),
        reservation('still-testing', 15)
      ] as any)

      const { data } = await feedGet(mockEvent('PROCTOR', { facilityId: 'fac-1' }))
      expect(data.facility.timezone).toBe('America/Los_Angeles')
      expect(data.departures.map(({ id, departureStatus }: any) => [id, departureStatus])).toEqual([
        ['overdue', 'OVERDUE'],
        ['ending-soon', 'ENDING_SOON'],
        ['newest-checkout', 'CHECKED_OUT'],
        ['old-checkout-with-later-scheduled-end', 'CHECKED_OUT']
      ])
      expect(data.departures[2].checkedOutAt).toBe(at(-2).toISOString())
    })

    it('returns facility capacity and grouped rosters', async () => {
      const now = new Date()
      const mockFacility = {
        id: 'fac-1',
        name: 'Main CBTF',
        totalSeats: 48,
        checkInLeadMinutes: 5,
        checkInGraceMinutes: 15
      }
      vi.mocked(prisma.cbtfFacility.findUnique).mockResolvedValue(mockFacility as any)

      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValue([
        {
          id: 'res-seated',
          facilityId: 'fac-1',
          assignmentId: 'asg-1',
          userId: 'usr-1',
          seatNumber: 12,
          startTime: new Date(now.getTime() - 20 * 60000),
          endTime: new Date(now.getTime() + 40 * 60000),
          status: 'CHECKED_IN',
          assignment: { title: 'Midterm 1' },
          user: { firstName: 'Alice', lastName: 'A', studentId: '906000001', avatarUrl: null }
        },
        {
          id: 'res-arriving',
          facilityId: 'fac-1',
          assignmentId: 'asg-2',
          userId: 'usr-2',
          seatNumber: 12,
          startTime: new Date(now.getTime() + 5 * 60000),
          endTime: new Date(now.getTime() + 65 * 60000),
          status: 'SCHEDULED',
          assignment: { title: 'Quiz 2' },
          user: { firstName: 'Bob', lastName: 'B', studentId: '906000002', avatarUrl: null }
        }
      ] as any)

      const event = mockEvent('PROCTOR', { facilityId: 'fac-1' })
      const res = await feedGet(event)

      expect(res.statusCode).toBe(200)
      expect(res.data.counts.seated).toBe(1)
      expect(res.data.counts.arriving).toBe(1)
      expect(res.data.seated).toMatchObject([{ id: 'res-seated', seatNumber: 12 }])
      expect(res.data.arriving).toMatchObject([{ id: 'res-arriving', seatNumber: 12 }])
      expect(res.data.seated[0].elapsedMinutes).toBeGreaterThanOrEqual(19)
      expect(res.data.facility.occupiedSeats).toBe(1)
      expect(res.data.facility.availableSeats).toBe(47)
    })
  })

  describe('Student Card Swipe Lookup', () => {
    it('returns STUDENT_NOT_FOUND when ID does not match any user', async () => {
      vi.mocked(prisma.user.findFirst).mockResolvedValue(null)

      const event = mockEvent('PROCTOR', { studentId: '999999999' })
      const res = await lookupGet(event)

      expect(res.data.found).toBe(false)
      expect(res.data.decision).toBe('STUDENT_NOT_FOUND')
    })

    it('returns READY_FOR_CHECKOUT when student is already seated', async () => {
      const mockUser = {
        id: 'usr-1',
        firstName: 'Alice',
        lastName: 'A',
        studentId: '906000001',
        email: 'alice@example.com',
        avatarUrl: null
      }
      vi.mocked(prisma.user.findFirst).mockResolvedValue(mockUser as any)

      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValueOnce([
        {
          id: 'res-seated',
          facilityId: 'fac-1',
          facility: { name: 'Facility A', checkInLeadMinutes: 5, checkInGraceMinutes: 15 },
          assignmentId: 'asg-1',
          userId: 'usr-1',
          seatNumber: 12,
          startTime: new Date(Date.now() - 5 * 60000),
          endTime: new Date(Date.now() + 55 * 60000),
          status: 'CHECKED_IN',
          assignment: { title: 'Midterm 1' }
        }
      ] as any)

      const event = mockEvent('PROCTOR', { studentId: '906000001' })
      const res = await lookupGet(event)

      expect(res.data.found).toBe(true)
      expect(res.data.decision).toBe('READY_FOR_CHECKOUT')
      expect(res.data.reservation.seatNumber).toBe(12)
    })

    it('returns READY_FOR_CHECKIN when student arrives within allowed window', async () => {
      const now = new Date()
      const mockUser = {
        id: 'usr-2',
        firstName: 'Bob',
        lastName: 'B',
        studentId: '906000002',
        email: 'bob@example.com',
        avatarUrl: null
      }
      vi.mocked(prisma.user.findFirst).mockResolvedValue(mockUser as any)

      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValueOnce([
        {
          id: 'res-arriving',
          facilityId: 'fac-1',
          facility: { name: 'Facility A', checkInLeadMinutes: 5, checkInGraceMinutes: 15 },
          assignmentId: 'asg-2',
          userId: 'usr-2',
          seatNumber: 15,
          startTime: new Date(now.getTime() + 3 * 60000),
          endTime: new Date(now.getTime() + 63 * 60000),
          status: 'SCHEDULED',
          assignment: { title: 'Quiz 2' }
        }
      ] as any)

      const event = mockEvent('PROCTOR', { studentId: '906000002' })
      const res = await lookupGet(event)

      expect(res.data.found).toBe(true)
      expect(res.data.decision).toBe('READY_FOR_CHECKIN')
      expect(res.data.reservation.seatNumber).toBe(15)
    })

    it('returns EARLY when student arrives more than lead allowance prior to test', async () => {
      const now = new Date()
      const mockUser = {
        id: 'usr-3',
        firstName: 'Charlie',
        lastName: 'C',
        studentId: '906000003',
        email: 'charlie@example.com',
        avatarUrl: null
      }
      vi.mocked(prisma.user.findFirst).mockResolvedValue(mockUser as any)

      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValueOnce([
        {
          id: 'res-future',
          facilityId: 'fac-1',
          facility: { name: 'Facility A', checkInLeadMinutes: 5, checkInGraceMinutes: 15 },
          assignmentId: 'asg-3',
          userId: 'usr-3',
          seatNumber: 20,
          startTime: new Date(now.getTime() + 25 * 60000),
          endTime: new Date(now.getTime() + 85 * 60000),
          status: 'SCHEDULED',
          assignment: { title: 'Final Exam' }
        }
      ] as any)

      const event = mockEvent('PROCTOR', { studentId: '906000003' })
      const res = await lookupGet(event)

      expect(res.data.decision).toBe('EARLY')
      expect(res.data.leadMinutes).toBe(5)
    })

    it('returns LATE when student arrives after grace period', async () => {
      const now = new Date()
      const mockUser = {
        id: 'usr-4',
        firstName: 'Dave',
        lastName: 'D',
        studentId: '906000004',
        email: 'dave@example.com',
        avatarUrl: null
      }
      vi.mocked(prisma.user.findFirst).mockResolvedValue(mockUser as any)

      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValueOnce([
        {
          id: 'res-past',
          facilityId: 'fac-1',
          facility: { name: 'Facility A', checkInLeadMinutes: 5, checkInGraceMinutes: 15 },
          assignmentId: 'asg-4',
          userId: 'usr-4',
          seatNumber: 8,
          startTime: new Date(now.getTime() - 25 * 60000),
          endTime: new Date(now.getTime() + 35 * 60000),
          status: 'SCHEDULED',
          assignment: { title: 'Exam 1' }
        }
      ] as any)

      const event = mockEvent('PROCTOR', { studentId: '906000004' })
      const res = await lookupGet(event)

      expect(res.data.decision).toBe('LATE')
      expect(res.data.graceMinutes).toBe(15)
    })
  })

  describe('Multi-facility lookup priority', () => {
    const reservation = (
      id: string,
      facilityId: string,
      start: number,
      end: number,
      status = 'SCHEDULED'
    ) => ({
      id,
      facilityId,
      status,
      seatNumber: 6,
      startTime: new Date(Date.now() + start * 60000),
      endTime: new Date(Date.now() + end * 60000),
      assignment: { title: 'Midterm' },
      facility: {
        name: facilityId,
        checkInLeadMinutes: facilityId === 'Facility B' ? 10 : 3,
        checkInGraceMinutes: 15
      }
    })

    beforeEach(() => {
      vi.mocked(prisma.user.findFirst).mockResolvedValue({
        id: 'usr-1',
        studentId: '906000001'
      } as any)
    })

    it.each(['Facility A', 'Facility B'])(
      'finds a reservation at %s without a facility filter',
      async (facilityId) => {
        vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValue([
          reservation('old', 'Facility A', -120, -60),
          reservation('current', facilityId, facilityId === 'Facility B' ? 8 : 2, 60)
        ] as any)
        const { data } = await lookupGet(mockEvent('PROCTOR', { studentId: '906000001' }))
        expect(data).toMatchObject({
          decision: 'READY_FOR_CHECKIN',
          leadMinutes: facilityId === 'Facility B' ? 10 : 3,
          reservation: {
            id: 'current',
            facilityId,
            facilityName: facilityId,
            seatNumber: 6,
            assignmentTitle: 'Midterm'
          }
        })
        expect(data.message).toContain(`${facilityId} · Seat #6`)
        expect(prisma.cbtfReservation.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { userId: 'usr-1', status: { in: ['CHECKED_IN', 'SCHEDULED'] } }
          })
        )
        expect(prisma.cbtfFacility.findFirst).not.toHaveBeenCalled()
      }
    )

    it('prioritizes a current checked-in reservation over a ready scheduled exam', async () => {
      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValue([
        reservation('seated', 'Facility B', -20, 40, 'CHECKED_IN'),
        reservation('ready', 'Facility A', 2, 62)
      ] as any)
      const { data } = await lookupGet(mockEvent('PROCTOR', { studentId: '906000001' }))
      expect(data).toMatchObject({
        decision: 'READY_FOR_CHECKOUT',
        reservation: { id: 'seated', facilityName: 'Facility B' }
      })
    })

    it('prefers the closest upcoming exam over overdue check-in and checkout candidates', async () => {
      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValue([
        reservation('old-seated', 'Facility B', -160, -100, 'CHECKED_IN'),
        reservation('late', 'Facility A', -25, 35),
        reservation('upcoming', 'Facility B', 30, 90),
        reservation('later', 'Facility A', 35, 95)
      ] as any)
      const { data } = await lookupGet(mockEvent('PROCTOR', { studentId: '906000001' }))
      expect(data).toMatchObject({ decision: 'EARLY', reservation: { id: 'upcoming' } })
    })

    it('allows an override for the most recent started exam that is still in progress', async () => {
      vi.mocked(prisma.cbtfReservation.findMany).mockResolvedValue([
        reservation('older-late', 'Facility A', -40, 20),
        reservation('recent-late', 'Facility B', -25, 35)
      ] as any)
      const { data } = await lookupGet(mockEvent('PROCTOR', { studentId: '906000001' }))
      expect(data).toMatchObject({
        decision: 'LATE',
        graceMinutes: 15,
        reservation: { id: 'recent-late', facilityName: 'Facility B' }
      })
      expect(data.message).toContain('Proctor override required')
    })
  })

  describe('Check-In & Check-Out Execution', () => {
    it.each(['fac-a', 'fac-b'])(
      'checks in reservation and records proctor user ID at %s',
      async (facilityId) => {
        vi.mocked(prisma.cbtfReservation.findUnique).mockResolvedValue({
          id: 'res-1',
          status: 'SCHEDULED',
          seatNumber: 10,
          facilityId,
          facility: { name: facilityId },
          assignment: { title: 'Midterm' },
          user: { firstName: 'Alice', lastName: 'A', studentId: '906000001', avatarUrl: null }
        } as any)

        vi.mocked(prisma.cbtfReservation.update).mockResolvedValue({
          id: 'res-1',
          status: 'CHECKED_IN',
          seatNumber: 10,
          facilityId,
          facility: { name: facilityId },
          checkedInAt: new Date(),
          checkedInByUserId: 'proctor-1',
          assignment: { title: 'Midterm' },
          user: { firstName: 'Alice', lastName: 'A', studentId: '906000001', avatarUrl: null }
        } as any)

        const event = mockEvent('PROCTOR', {}, { reservationId: 'res-1' })
        const res = await checkInPost(event)

        expect(res.statusCode).toBe(200)
        expect(res.data).toMatchObject({ facilityId, facilityName: facilityId, seatNumber: 10 })
        const update = vi.mocked(prisma.cbtfReservation.update).mock.calls[0]?.[0].data
        expect(update).not.toHaveProperty('facilityId')
        expect(update).not.toHaveProperty('seatNumber')
        expect(res.data.status).toBe('CHECKED_IN')
        expect(prisma.cbtfReservation.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: 'res-1' },
            data: expect.objectContaining({
              status: 'CHECKED_IN',
              checkedInByUserId: 'proctor-1'
            })
          })
        )
      }
    )

    it('rejects check-in when scanned student ID does not match the reservation', async () => {
      vi.mocked(prisma.cbtfReservation.findUnique).mockResolvedValue({
        id: 'res-1',
        status: 'SCHEDULED',
        user: { studentId: '906000001' }
      } as any)

      await expect(
        checkInPost(
          mockEvent(
            'PROCTOR',
            {},
            {
              reservationId: 'res-1',
              studentId: '906000999'
            }
          )
        )
      ).rejects.toThrow('Student ID does not match this reservation')
      expect(prisma.cbtfReservation.update).not.toHaveBeenCalled()
    })

    it('rejects check-in when the seat is out of service', async () => {
      vi.mocked(prisma.cbtfReservation.findUnique).mockResolvedValue({
        id: 'res-1',
        status: 'SCHEDULED',
        seatNumber: 10,
        facilityId: 'fac-a',
        user: { studentId: '906000001' }
      } as any)
      vi.mocked(prisma.cbtfSeatStatus.findUnique).mockResolvedValue({ isDisabled: true } as any)

      await expect(
        checkInPost(mockEvent('PROCTOR', {}, { reservationId: 'res-1' }))
      ).rejects.toThrow('Move the student to another seat before checking in')
      expect(prisma.cbtfReservation.update).not.toHaveBeenCalled()
    })

    it('rejects checkout when scanned student ID does not match the reservation', async () => {
      vi.mocked(prisma.cbtfReservation.findUnique).mockResolvedValue({
        id: 'res-1',
        status: 'CHECKED_IN',
        user: { studentId: '906000001' }
      } as any)

      await expect(
        checkOutPost(
          mockEvent(
            'PROCTOR',
            {},
            {
              reservationId: 'res-1',
              studentId: '906000999'
            }
          )
        )
      ).rejects.toThrow('Student ID does not match this reservation')
      expect(prisma.cbtfReservation.update).not.toHaveBeenCalled()
    })

    it.each(['fac-a', 'fac-b'])(
      'checks out reservation and records proctor user ID at %s',
      async (facilityId) => {
        vi.mocked(prisma.cbtfReservation.findUnique).mockResolvedValue({
          id: 'res-1',
          status: 'CHECKED_IN',
          seatNumber: 10,
          facilityId,
          facility: { name: facilityId },
          assignment: { title: 'Midterm' },
          user: { firstName: 'Alice', lastName: 'A', studentId: '906000001', avatarUrl: null }
        } as any)

        vi.mocked(prisma.cbtfReservation.update).mockResolvedValue({
          id: 'res-1',
          status: 'CHECKED_OUT',
          seatNumber: 10,
          facilityId,
          facility: { name: facilityId },
          checkedOutAt: new Date(),
          checkedOutByUserId: 'proctor-1',
          assignment: { title: 'Midterm' },
          user: { firstName: 'Alice', lastName: 'A', studentId: '906000001', avatarUrl: null }
        } as any)

        const event = mockEvent('PROCTOR', {}, { reservationId: 'res-1' })
        const res = await checkOutPost(event)

        expect(res.statusCode).toBe(200)
        expect(res.data).toMatchObject({ facilityId, facilityName: facilityId, seatNumber: 10 })
        const update = vi.mocked(prisma.cbtfReservation.update).mock.calls[0]?.[0].data
        expect(update).not.toHaveProperty('facilityId')
        expect(update).not.toHaveProperty('seatNumber')
        expect(res.data.status).toBe('CHECKED_OUT')
        expect(prisma.cbtfReservation.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: 'res-1' },
            data: expect.objectContaining({
              status: 'CHECKED_OUT',
              checkedOutByUserId: 'proctor-1'
            })
          })
        )
      }
    )
  })
})
