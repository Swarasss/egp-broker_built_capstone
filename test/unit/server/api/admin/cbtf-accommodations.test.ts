import { describe, it, expect, vi, beforeEach } from 'vitest'
import accommodationsGet from '../../../../../server/api/admin/cbtf/accommodations.get'
import accommodationPut from '../../../../../server/api/admin/cbtf/accommodations/[userId].put'
import accommodationDelete from '../../../../../server/api/admin/cbtf/accommodations/[userId].delete'
import seatsGet from '../../../../../server/api/admin/cbtf/seats.get'
import seatsPut from '../../../../../server/api/admin/cbtf/seats.put'
import prisma from '@@/server/utils/db'

vi.mock('@@/server/utils/db', () => ({
  default: {
    user: { findUnique: vi.fn() },
    cbtfFacility: { findUnique: vi.fn(), findFirst: vi.fn() },
    cbtfSeat: { findMany: vi.fn(), createMany: vi.fn(), deleteMany: vi.fn() },
    cbtfStudentAccommodation: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn()
    },
    $transaction: vi.fn((cb: any) => cb(prisma))
  }
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
      Object.assign(err, opts)
      return err
    }
  }
})

const mockEvent = (
  userRole: string | null = 'ADMIN',
  body = {},
  params = {},
  query = {}
): any => ({
  context: {
    user: userRole ? { id: 'admin-1', globalRole: userRole } : null,
    params
  },
  node: { req: { method: 'GET' } },
  _body: body,
  _query: query
})

const student = {
  id: 'usr-1',
  firstName: 'Demo',
  lastName: 'User',
  email: 'demo@example.com',
  studentId: '906000001'
}

describe('Admin CBTF SSD endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.$transaction).mockImplementation((async (cb: any) => cb(prisma)) as any)
  })

  describe('GET /api/admin/cbtf/accommodations', () => {
    it('rejects unauthenticated and non-admin callers', async () => {
      await expect(accommodationsGet(mockEvent(null))).rejects.toMatchObject({ statusCode: 401 })
      await expect(accommodationsGet(mockEvent('USER'))).rejects.toMatchObject({ statusCode: 403 })
    })

    it('returns mapped accommodation rows', async () => {
      vi.mocked(prisma.cbtfStudentAccommodation.findMany).mockResolvedValue([
        {
          userId: 'usr-1',
          requiredSeatProperties: ['SSD'],
          timeMultiplier: 1.5,
          isActive: true,
          notes: 'Extra time',
          updatedAt: new Date('2030-01-01T00:00:00.000Z'),
          user: student
        }
      ] as any)

      const response = await accommodationsGet(mockEvent())

      expect(response.statusCode).toBe(200)
      expect(response.data[0]).toMatchObject({
        userId: 'usr-1',
        studentName: 'Demo User',
        studentEmail: 'demo@example.com',
        requiredSeatProperties: ['SSD'],
        timeMultiplier: 1.5
      })
    })
  })

  describe('PUT /api/admin/cbtf/accommodations/[userId]', () => {
    it('rejects non-admin callers', async () => {
      await expect(
        accommodationPut(mockEvent('PROCTOR', {}, { userId: 'usr-1' }))
      ).rejects.toMatchObject({ statusCode: 403 })
    })

    it('rejects a multiplier outside the supported range', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(student as any)

      await expect(
        accommodationPut(
          mockEvent('ADMIN', { timeMultiplier: 4, requiredSeatProperties: ['SSD'] }, { userId: 'usr-1' })
        )
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('returns 404 for an unknown student', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null)

      await expect(
        accommodationPut(
          mockEvent('ADMIN', { timeMultiplier: 1.5, requiredSeatProperties: [] }, { userId: 'missing' })
        )
      ).rejects.toMatchObject({ statusCode: 404 })
    })

    it('upserts the accommodation for the student', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(student as any)
      vi.mocked(prisma.cbtfStudentAccommodation.upsert).mockResolvedValue({
        userId: 'usr-1',
        requiredSeatProperties: ['SSD', 'ADJUSTABLE_DESK'],
        timeMultiplier: 1.5,
        isActive: true,
        notes: 'Needs quiet room',
        updatedAt: new Date('2030-01-01T00:00:00.000Z')
      } as any)

      const response = await accommodationPut(
        mockEvent(
          'ADMIN',
          {
            timeMultiplier: 1.5,
            requiredSeatProperties: ['SSD', 'ADJUSTABLE_DESK'],
            notes: 'Needs quiet room'
          },
          { userId: 'usr-1' }
        )
      )

      expect(response.statusCode).toBe(200)
      expect(response.data).toMatchObject({
        userId: 'usr-1',
        timeMultiplier: 1.5,
        requiredSeatProperties: ['SSD', 'ADJUSTABLE_DESK']
      })
      expect(prisma.cbtfStudentAccommodation.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 'usr-1' },
          create: expect.objectContaining({
            userId: 'usr-1',
            timeMultiplier: 1.5,
            updatedById: 'admin-1'
          })
        })
      )
    })
  })

  describe('DELETE /api/admin/cbtf/accommodations/[userId]', () => {
    it('returns 404 when no accommodation exists', async () => {
      vi.mocked(prisma.cbtfStudentAccommodation.deleteMany).mockResolvedValue({ count: 0 })

      await expect(
        accommodationDelete(mockEvent('ADMIN', {}, { userId: 'usr-1' }))
      ).rejects.toMatchObject({ statusCode: 404 })
    })

    it('removes the accommodation', async () => {
      vi.mocked(prisma.cbtfStudentAccommodation.deleteMany).mockResolvedValue({ count: 1 })

      const response = await accommodationDelete(mockEvent('ADMIN', {}, { userId: 'usr-1' }))

      expect(response.statusCode).toBe(200)
      expect(prisma.cbtfStudentAccommodation.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'usr-1' }
      })
    })
  })

  describe('GET /api/admin/cbtf/seats', () => {
    it('returns every seat with its certifications', async () => {
      vi.mocked(prisma.cbtfFacility.findFirst).mockResolvedValue({
        id: 'fac-1',
        name: 'Main CBTF',
        totalSeats: 3
      } as any)
      vi.mocked(prisma.cbtfSeat.findMany).mockResolvedValue([
        { seatNumber: 2, properties: ['SSD'] }
      ] as any)

      const response = await seatsGet(mockEvent('ADMIN'))

      expect(response.statusCode).toBe(200)
      expect(response.data.totalSeats).toBe(3)
      expect(response.data.seats).toEqual([
        { seatNumber: 1, properties: [] },
        { seatNumber: 2, properties: ['SSD'] },
        { seatNumber: 3, properties: [] }
      ])
    })
  })

  describe('PUT /api/admin/cbtf/seats', () => {
    beforeEach(() => {
      vi.mocked(prisma.cbtfFacility.findUnique).mockResolvedValue({
        id: 'fac-1',
        name: 'Main CBTF',
        totalSeats: 2
      } as any)
    })

    it('rejects seat numbers outside the facility capacity', async () => {
      await expect(
        seatsPut(
          mockEvent('ADMIN', {
            facilityId: 'fac-1',
            seats: [{ seatNumber: 9, properties: ['SSD'] }]
          })
        )
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('replaces the certification map', async () => {
      vi.mocked(prisma.cbtfSeat.deleteMany).mockResolvedValue({ count: 2 })
      vi.mocked(prisma.cbtfSeat.createMany).mockResolvedValue({ count: 1 })

      const response = await seatsPut(
        mockEvent('ADMIN', {
          facilityId: 'fac-1',
          seats: [
            { seatNumber: 1, properties: [] },
            { seatNumber: 2, properties: ['SSD', 'ADJUSTABLE_DESK'] }
          ]
        })
      )

      expect(response.statusCode).toBe(200)
      expect(prisma.cbtfSeat.deleteMany).toHaveBeenCalledWith({ where: { facilityId: 'fac-1' } })
      expect(prisma.cbtfSeat.createMany).toHaveBeenCalledWith({
        data: [
          { facilityId: 'fac-1', seatNumber: 2, properties: ['SSD', 'ADJUSTABLE_DESK'] }
        ]
      })
      expect(response.data.seats[1]).toEqual({
        seatNumber: 2,
        properties: ['SSD', 'ADJUSTABLE_DESK']
      })
    })
  })
})
