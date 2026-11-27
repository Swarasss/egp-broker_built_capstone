import { describe, expect, it, vi } from 'vitest'
import {
  configureSpareSeats,
  getWorkstationSummary,
  moveReservationToSeat,
  returnSeatToService,
  takeSeatOutOfService
} from '@@/server/utils/cbtf-workstations'
import { applySeatOutOfServiceFlags } from '@@/server/utils/cbtf'

vi.mock('@@/server/utils/db', () => ({ default: {} }))

interface StoreOptions {
  totalSeats?: number
  spareSeatCount?: number | null
  spareSeatNumbers?: number[]
  seats?: Array<{ seatNumber: number; properties: string[] }>
  seatStatuses?: Array<{
    seatNumber: number
    isDisabled: boolean
    reason?: string | null
    disabledAt?: Date
  }>
  reservations?: Array<Record<string, any>>
  accommodations?: Array<{ userId: string; requiredSeatProperties: string[]; isActive: boolean }>
}

function createStore(options: StoreOptions = {}) {
  const totalSeats = options.totalSeats ?? 20
  const facility: any = {
    id: 'fac-1',
    name: 'Room',
    totalSeats,
    seatAllocationOrder: Array.from({ length: totalSeats }, (_, index) => index + 1),
    spareSeatCount: options.spareSeatCount ?? 2,
    spareSeatNumbers: options.spareSeatNumbers ?? [19, 20],
    reassignThresholdMinutes: 60
  }
  const seats = (options.seats ?? []).map((seat) => ({ facilityId: facility.id, ...seat }))
  const seatStatuses = (options.seatStatuses ?? []).map((status) => ({
    facilityId: facility.id,
    ...status
  }))
  const reservations = (options.reservations ?? []).map((reservation) => ({
    facilityId: facility.id,
    ...reservation
  }))
  return {
    facility,
    seats,
    seatStatuses,
    reservations,
    accommodations: options.accommodations ?? [],
    notes: [] as any[],
    users: {} as Record<string, any>,
    assignments: {} as Record<string, any>
  }
}

type Store = ReturnType<typeof createStore>

function matchReservation(reservation: any, where: any = {}): boolean {
  if (where.facilityId && reservation.facilityId !== where.facilityId) return false
  if (where.seatNumber !== undefined) {
    if (Array.isArray(where.seatNumber?.in)) {
      if (!where.seatNumber.in.includes(reservation.seatNumber)) return false
    } else if (reservation.seatNumber !== where.seatNumber) {
      return false
    }
  }
  if (where.id?.not && reservation.id === where.id.not) return false
  if (where.status?.in && !where.status.in.includes(reservation.status)) return false
  if (where.endTime?.gt && !(new Date(reservation.endTime) > new Date(where.endTime.gt)))
    return false
  if (where.endTime?.lt && !(new Date(reservation.endTime) < new Date(where.endTime.lt)))
    return false
  if (where.startTime?.lte && !(new Date(reservation.startTime) <= new Date(where.startTime.lte))) {
    return false
  }
  if (where.startTime?.gte && !(new Date(reservation.startTime) >= new Date(where.startTime.gte))) {
    return false
  }
  return true
}

function attachFacility(store: Store, include?: any) {
  const facility: any = { ...store.facility }
  if (include?.seats) facility.seats = store.seats
  if (include?.seatStatuses) facility.seatStatuses = store.seatStatuses
  return facility
}

function attachReservation(store: Store, reservation: any, include?: any) {
  const base: any = { ...reservation }
  if (include?.user) base.user = store.users[reservation.userId] ?? null
  if (include?.assignment) base.assignment = store.assignments[reservation.assignmentId] ?? null
  if (include?.notes)
    base.notes = store.notes.filter((note) => note.reservationId === reservation.id)
  if (include?.facility) {
    base.facility = include.facility.include
      ? attachFacility(store, include.facility.include)
      : { name: store.facility.name }
  }
  return base
}

function createDb(store: Store) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    cbtfFacility: {
      findUnique: vi.fn(async ({ where, include }: any) => {
        if (where.id !== store.facility.id) return null
        return attachFacility(store, include)
      }),
      update: vi.fn(async ({ where, data }: any) => {
        if (where.id !== store.facility.id) throw new Error('Facility not found')
        Object.assign(store.facility, data)
        return { ...store.facility }
      })
    },
    cbtfSeatStatus: {
      upsert: vi.fn(async ({ where, update, create }: any) => {
        const { facilityId, seatNumber } = where.facilityId_seatNumber
        const existing = store.seatStatuses.find(
          (status) => status.facilityId === facilityId && status.seatNumber === seatNumber
        )
        if (existing) {
          Object.assign(existing, update)
          return existing
        }
        const row = { facilityId, seatNumber, isDisabled: true, ...create }
        store.seatStatuses.push(row)
        return row
      }),
      findMany: vi.fn(async ({ where }: any) =>
        store.seatStatuses.filter((status) => {
          if (Array.isArray(where.facilityId?.in)) {
            if (!where.facilityId.in.includes(status.facilityId)) return false
          } else if (where.facilityId && status.facilityId !== where.facilityId) {
            return false
          }
          if (where.isDisabled !== undefined && status.isDisabled !== where.isDisabled) return false
          return true
        })
      ),
      deleteMany: vi.fn(async ({ where }: any) => {
        const before = store.seatStatuses.length
        store.seatStatuses = store.seatStatuses.filter(
          (status) =>
            !(status.facilityId === where.facilityId && status.seatNumber === where.seatNumber)
        )
        return { count: before - store.seatStatuses.length }
      })
    },
    cbtfReservation: {
      findMany: vi.fn(async ({ where, include, orderBy }: any) => {
        let rows = store.reservations.filter((reservation) => matchReservation(reservation, where))
        if (orderBy?.startTime === 'asc') {
          rows = [...rows].sort((a, b) => +new Date(a.startTime) - +new Date(b.startTime))
        }
        return rows.map((reservation) => attachReservation(store, reservation, include))
      }),
      findUnique: vi.fn(async ({ where, include }: any) => {
        const reservation = store.reservations.find((row) => row.id === where.id)
        return reservation ? attachReservation(store, reservation, include) : null
      }),
      update: vi.fn(async ({ where, data, include }: any) => {
        const reservation = store.reservations.find((row) => row.id === where.id)
        if (!reservation) throw new Error('Reservation not found')
        Object.assign(reservation, data)
        return attachReservation(store, reservation, include)
      })
    },
    cbtfReservationNote: {
      create: vi.fn(async ({ data }: any) => {
        const note = { id: `note-${store.notes.length + 1}`, ...data }
        store.notes.push(note)
        return note
      })
    },
    cbtfStudentAccommodation: {
      findMany: vi.fn(async ({ where }: any) =>
        store.accommodations.filter(
          (accommodation) =>
            where.userId?.in?.includes(accommodation.userId) &&
            (where.isActive === undefined || accommodation.isActive === where.isActive)
        )
      ),
      findUnique: vi.fn(
        async ({ where }: any) =>
          store.accommodations.find((accommodation) => accommodation.userId === where.userId) ??
          null
      )
    }
  }
}

const NOW = new Date('2030-01-01T10:00:00Z')
const at = (hoursFromNow: number) => new Date(NOW.getTime() + hoursFromNow * 60 * 60 * 1000)

describe('CBTF workstations', () => {
  it('summarizes seat states, capacity, and at-risk reservations', async () => {
    const store = createStore({
      seatStatuses: [{ seatNumber: 5, isDisabled: true, reason: 'broken', disabledAt: at(-1) }],
      seats: [{ seatNumber: 1, properties: ['SSD'] }],
      reservations: [
        {
          id: 'live-1',
          userId: 'u1',
          assignmentId: 'a1',
          seatNumber: 1,
          status: 'CHECKED_IN',
          startTime: at(-0.5),
          endTime: at(0.5)
        },
        {
          id: 'risk-1',
          userId: 'u1',
          assignmentId: 'a1',
          seatNumber: 5,
          status: 'SCHEDULED',
          startTime: at(1),
          endTime: at(2)
        }
      ]
    })
    store.users.u1 = { firstName: 'Ada', lastName: 'Student' }
    store.assignments.a1 = { title: 'Exam' }

    const summary = await getWorkstationSummary(createDb(store) as any, 'fac-1', NOW)

    expect(summary.counts).toMatchObject({
      total: 20,
      working: 19,
      available: 17,
      spare: 2,
      outOfService: 1
    })
    expect(summary.seats.find((seat) => seat.seatNumber === 5)?.state).toBe('OUT_OF_SERVICE')
    expect(summary.seats.find((seat) => seat.seatNumber === 19)?.state).toBe('SPARE')
    expect(summary.seats.find((seat) => seat.seatNumber === 1)?.state).toBe('IN_SERVICE')
    expect(summary.seats.find((seat) => seat.seatNumber === 1)?.properties).toEqual(['SSD'])
    expect(summary.seats.find((seat) => seat.seatNumber === 1)?.occupied).toBe(true)
    expect(summary.seats.find((seat) => seat.seatNumber === 1)?.currentReservation).toMatchObject({
      reservationId: 'live-1',
      studentName: 'Ada Student',
      assignmentTitle: 'Exam'
    })
    expect(summary.seats.find((seat) => seat.seatNumber === 2)?.properties).toEqual([])
    expect(summary.seats.find((seat) => seat.seatNumber === 2)?.occupied).toBe(false)
    expect(summary.atRisk).toHaveLength(1)
    expect(summary.atRisk[0]).toMatchObject({
      reservationId: 'risk-1',
      seatNumber: 5,
      studentName: 'Ada Student',
      assignmentTitle: 'Exam'
    })
  })

  it('marks reservation DTOs whose seat is out of service', async () => {
    const store = createStore({
      seatStatuses: [{ seatNumber: 5, isDisabled: true }]
    })
    const rows = [
      { facilityId: 'fac-1', seatNumber: 5, seatOutOfService: false },
      { facilityId: 'fac-1', seatNumber: 6 }
    ]

    await applySeatOutOfServiceFlags(createDb(store) as any, rows)

    expect(rows[0]?.seatOutOfService).toBe(true)
    expect(rows[1]?.seatOutOfService).toBe(false)
  })

  it('takes a seat out of service and flags affected reservations', async () => {
    const store = createStore({
      reservations: [
        {
          id: 'r1',
          userId: 'u1',
          assignmentId: 'a1',
          seatNumber: 5,
          status: 'CHECKED_IN',
          startTime: at(-0.5),
          endTime: at(0.5)
        },
        {
          id: 'r2',
          userId: 'u2',
          assignmentId: 'a1',
          seatNumber: 5,
          status: 'SCHEDULED',
          startTime: at(2),
          endTime: at(3)
        }
      ]
    })
    store.users.u1 = { firstName: 'Ada', lastName: 'Student' }
    store.users.u2 = { firstName: 'Grace', lastName: 'Student' }
    store.assignments.a1 = { title: 'Exam' }

    const result = await takeSeatOutOfService(createDb(store) as any, {
      facilityId: 'fac-1',
      seatNumber: 5,
      reason: 'monitor dead',
      userId: 'proctor-1',
      now: NOW
    })

    expect(result.moved).toEqual([])
    expect(result.atRisk.map((row) => row.reservationId)).toEqual(['r1', 'r2'])
    expect(store.reservations.find((row) => row.id === 'r1')?.seatNumber).toBe(5)
    expect(store.reservations.find((row) => row.id === 'r2')?.seatNumber).toBe(5)
    expect(store.notes).toHaveLength(0)
    expect(result.summary.counts.outOfService).toBe(1)
  })

  it('flags a reservation when every other seat is occupied', async () => {
    const store = createStore({
      totalSeats: 6,
      spareSeatCount: 0,
      spareSeatNumbers: [],
      reservations: [
        {
          id: 'r1',
          userId: 'u1',
          assignmentId: 'a1',
          seatNumber: 5,
          status: 'CHECKED_IN',
          startTime: at(-0.5),
          endTime: at(0.5)
        },
        {
          id: 'r2',
          userId: 'u2',
          assignmentId: 'a1',
          seatNumber: 1,
          status: 'SCHEDULED',
          startTime: at(-0.5),
          endTime: at(0.5)
        },
        {
          id: 'r3',
          userId: 'u2',
          assignmentId: 'a1',
          seatNumber: 2,
          status: 'SCHEDULED',
          startTime: at(-0.5),
          endTime: at(0.5)
        },
        {
          id: 'r4',
          userId: 'u2',
          assignmentId: 'a1',
          seatNumber: 3,
          status: 'SCHEDULED',
          startTime: at(-0.5),
          endTime: at(0.5)
        },
        {
          id: 'r5',
          userId: 'u2',
          assignmentId: 'a1',
          seatNumber: 4,
          status: 'SCHEDULED',
          startTime: at(-0.5),
          endTime: at(0.5)
        },
        {
          id: 'r6',
          userId: 'u2',
          assignmentId: 'a1',
          seatNumber: 6,
          status: 'SCHEDULED',
          startTime: at(-0.5),
          endTime: at(0.5)
        }
      ]
    })
    store.users.u1 = { firstName: 'Ada', lastName: 'Student' }
    store.assignments.a1 = { title: 'Exam' }

    const result = await takeSeatOutOfService(createDb(store) as any, {
      facilityId: 'fac-1',
      seatNumber: 5,
      userId: 'proctor-1',
      now: NOW
    })

    expect(result.moved).toEqual([])
    expect(result.atRisk.map((row) => row.reservationId)).toEqual(['r1'])
  })

  it('lists an accommodated reservation as at risk without moving it', async () => {
    const store = createStore({
      spareSeatCount: 1,
      spareSeatNumbers: [20],
      seats: [{ seatNumber: 1, properties: ['SSD'] }],
      accommodations: [{ userId: 'u1', requiredSeatProperties: ['SSD'], isActive: true }],
      reservations: [
        {
          id: 'r1',
          userId: 'u1',
          assignmentId: 'a1',
          seatNumber: 5,
          status: 'CHECKED_IN',
          startTime: at(-0.5),
          endTime: at(0.5)
        }
      ]
    })
    store.users.u1 = { firstName: 'Sam', lastName: 'Accommodated' }
    store.assignments.a1 = { title: 'Exam' }

    const result = await takeSeatOutOfService(createDb(store) as any, {
      facilityId: 'fac-1',
      seatNumber: 5,
      userId: 'proctor-1',
      now: NOW
    })

    expect(result.moved).toEqual([])
    expect(result.atRisk.map((row) => row.reservationId)).toEqual(['r1'])
    expect(store.reservations.find((row) => row.id === 'r1')?.seatNumber).toBe(5)
  })

  it('returns a seat to service', async () => {
    const store = createStore({
      seatStatuses: [{ seatNumber: 5, isDisabled: true, reason: 'broken', disabledAt: at(-1) }]
    })
    const result = await returnSeatToService(createDb(store) as any, {
      facilityId: 'fac-1',
      seatNumber: 5,
      userId: 'proctor-1',
      now: NOW
    })
    expect(store.seatStatuses).toHaveLength(0)
    expect(result.summary.counts.outOfService).toBe(0)
  })

  it('configures spare seats from the tail of the allocation order', async () => {
    const store = createStore()
    await configureSpareSeats(createDb(store) as any, {
      facilityId: 'fac-1',
      spareSeatCount: 3
    })
    expect(store.facility.spareSeatCount).toBe(3)
    expect(store.facility.spareSeatNumbers).toEqual([18, 19, 20])
  })

  it('moves a reservation to an available spare seat', async () => {
    const store = createStore({
      seatStatuses: [{ seatNumber: 5, isDisabled: true }],
      reservations: [
        {
          id: 'r1',
          userId: 'u1',
          assignmentId: 'a1',
          seatNumber: 5,
          status: 'SCHEDULED',
          startTime: at(1),
          endTime: at(2)
        }
      ]
    })
    store.users.u1 = {
      firstName: 'Ada',
      lastName: 'Student',
      email: 'ada@example.com',
      studentId: '1',
      avatarUrl: null
    }
    store.assignments.a1 = { title: 'Exam' }

    const db = createDb(store)
    const dto = await moveReservationToSeat(db as any, {
      reservationId: 'r1',
      userId: 'proctor-1',
      now: NOW
    })
    expect(db.$queryRaw).toHaveBeenCalled()
    expect(dto.seatNumber).toBe(19)
    expect(store.reservations[0]?.seatNumber).toBe(19)
    expect(store.notes).toHaveLength(1)
  })

  it('rejects moving to an out-of-service seat', async () => {
    const store = createStore({
      seatStatuses: [
        { seatNumber: 3, isDisabled: true },
        { seatNumber: 5, isDisabled: true }
      ],
      reservations: [
        {
          id: 'r1',
          userId: 'u1',
          assignmentId: 'a1',
          seatNumber: 5,
          status: 'SCHEDULED',
          startTime: at(1),
          endTime: at(2)
        }
      ]
    })
    await expect(
      moveReservationToSeat(createDb(store) as any, {
        reservationId: 'r1',
        targetSeatNumber: 3,
        userId: 'proctor-1',
        now: NOW
      })
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('moves to another free working seat when no spare matches the accommodation', async () => {
    const store = createStore({
      spareSeatCount: 1,
      spareSeatNumbers: [20],
      seatStatuses: [{ seatNumber: 5, isDisabled: true }],
      seats: [{ seatNumber: 1, properties: ['SSD'] }],
      accommodations: [{ userId: 'u1', requiredSeatProperties: ['SSD'], isActive: true }],
      reservations: [
        {
          id: 'r1',
          userId: 'u1',
          assignmentId: 'a1',
          seatNumber: 5,
          status: 'SCHEDULED',
          startTime: at(1),
          endTime: at(2)
        }
      ]
    })
    store.users.u1 = {
      firstName: 'Sam',
      lastName: 'Accommodated',
      email: 'sam@example.com',
      studentId: '1',
      avatarUrl: null
    }
    store.assignments.a1 = { title: 'Exam' }

    const dto = await moveReservationToSeat(createDb(store) as any, {
      reservationId: 'r1',
      userId: 'proctor-1',
      now: NOW
    })
    expect(dto.seatNumber).toBe(1)
  })

  it('rejects moving when no eligible seat is available', async () => {
    const store = createStore({
      spareSeatCount: 1,
      spareSeatNumbers: [20],
      seatStatuses: [{ seatNumber: 5, isDisabled: true }],
      accommodations: [{ userId: 'u1', requiredSeatProperties: ['SSD'], isActive: true }],
      reservations: [
        {
          id: 'r1',
          userId: 'u1',
          assignmentId: 'a1',
          seatNumber: 5,
          status: 'SCHEDULED',
          startTime: at(1),
          endTime: at(2)
        }
      ]
    })
    await expect(
      moveReservationToSeat(createDb(store) as any, {
        reservationId: 'r1',
        userId: 'proctor-1',
        now: NOW
      })
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('does not auto-move a reservation whose seat is already in service', async () => {
    const store = createStore({
      reservations: [
        {
          id: 'r1',
          userId: 'u1',
          assignmentId: 'a1',
          seatNumber: 5,
          status: 'SCHEDULED',
          startTime: at(1),
          endTime: at(2)
        }
      ]
    })
    const db = createDb(store)

    await expect(
      moveReservationToSeat(db as any, {
        reservationId: 'r1',
        userId: 'proctor-1',
        now: NOW
      })
    ).rejects.toMatchObject({ statusCode: 409 })
    expect(db.cbtfReservation.update).not.toHaveBeenCalled()
  })
})
