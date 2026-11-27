import { createError } from 'h3'
import type { Prisma, PrismaClient } from '@prisma/client'
import {
  computeSpareSeatNumbers,
  getAllocatableSeatNumbers,
  getDisabledSeatNumbers,
  getRecommendedSpareSeatCount,
  getSeatCapacityCounts,
  getSeatOrder,
  getSpareSeatNumbers,
  getWorkingSeatNumbers
} from '@@/shared/utils/cbtf-seats'
import { isSeatEligibleForStudent, toCbtfReservationDto } from './cbtf'
import { lockCbtfFacilities } from './cbtf-placement'
import type {
  CbtfAtRiskReservationDto,
  CbtfReservationDto,
  CbtfSeatOccupancyDto,
  CbtfSeatState,
  CbtfSeatStatusDto,
  CbtfWorkstationCounts,
  CbtfWorkstationSummary
} from '@@/shared/models/cbtf'

type Db = PrismaClient | Prisma.TransactionClient

interface WorkstationFacility {
  id: string
  name: string
  totalSeats: number
  seatAllocationOrder: unknown
  spareSeatCount: number | null
  spareSeatNumbers: unknown
  reassignThresholdMinutes: number
  seats?: Array<{ seatNumber: number; properties: string[] }>
  seatStatuses?: Array<{
    seatNumber: number
    isDisabled: boolean
    reason?: string | null
    disabledAt?: Date | string | null
  }>
}

interface WorkstationReservation {
  id: string
  facilityId: string
  userId: string
  seatNumber: number
  startTime: Date | string
  endTime: Date | string
  status: string
  user?: { firstName: string; lastName: string } | null
  assignment?: { title: string } | null
}

export interface MovedReservation {
  reservationId: string
  fromSeat: number
  toSeat: number
}

export interface SeatMutationResult {
  summary: CbtfWorkstationSummary
  moved: MovedReservation[]
  atRisk: CbtfAtRiskReservationDto[]
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function overlaps(
  aStart: Date | string,
  aEnd: Date | string,
  bStart: Date | string,
  bEnd: Date | string
): boolean {
  return new Date(aStart) < new Date(bEnd) && new Date(aEnd) > new Date(bStart)
}

function seatState(seatNumber: number, disabled: Set<number>, spares: Set<number>): CbtfSeatState {
  if (disabled.has(seatNumber)) return 'OUT_OF_SERVICE'
  if (spares.has(seatNumber)) return 'SPARE'
  return 'IN_SERVICE'
}

async function loadFacility(db: Db, facilityId: string): Promise<WorkstationFacility> {
  const facility = await (db as any).cbtfFacility.findUnique({
    where: { id: facilityId },
    include: { seats: true, seatStatuses: true }
  })
  if (!facility) {
    throw createError({ statusCode: 404, statusMessage: 'Testing facility not found' })
  }
  return facility as WorkstationFacility
}

function ensureSeatNumber(facility: WorkstationFacility, seatNumber: number): void {
  if (!Number.isInteger(seatNumber) || seatNumber < 1 || seatNumber > facility.totalSeats) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid seat number' })
  }
}

function toAtRisk(reservation: WorkstationReservation): CbtfAtRiskReservationDto {
  const name = reservation.user
    ? `${reservation.user.firstName} ${reservation.user.lastName}`.trim()
    : ''
  return {
    reservationId: reservation.id,
    seatNumber: reservation.seatNumber,
    userId: reservation.userId,
    studentName: name,
    assignmentTitle: reservation.assignment?.title ?? '',
    startTime: toIso(reservation.startTime) ?? '',
    endTime: toIso(reservation.endTime) ?? '',
    status: reservation.status as CbtfAtRiskReservationDto['status']
  }
}

/**
 * Candidate seats for moving a student, in priority order:
 * spare seats first (kept open for this purpose), then any other working
 * (in-service, non-spare) seat. The current seat and out-of-service seats are excluded.
 */
function getMoveCandidates(
  facility: WorkstationFacility,
  disabledSeatNumbers: number[],
  currentSeatNumber: number
): number[] {
  const spares = getSpareSeatNumbers(facility, disabledSeatNumbers)
  const allocatable = getAllocatableSeatNumbers(facility, disabledSeatNumbers)
  const seen = new Set<number>([currentSeatNumber])
  const candidates: number[] = []
  for (const seat of [...spares, ...allocatable]) {
    if (seen.has(seat)) continue
    seen.add(seat)
    candidates.push(seat)
  }
  return candidates
}

function pickTargetSeat(args: {
  reservation: WorkstationReservation
  candidates: number[]
  propertiesBySeat: Map<number, string[]>
  requiredProperties: string[]
  reservations: WorkstationReservation[]
}): number | null {
  const { reservation, candidates, propertiesBySeat, requiredProperties, reservations } = args
  for (const seat of candidates) {
    if (seat === reservation.seatNumber) continue
    if (!isSeatEligibleForStudent(propertiesBySeat.get(seat) ?? [], requiredProperties)) continue
    const occupied = reservations.some(
      (other) =>
        other.id !== reservation.id &&
        other.seatNumber === seat &&
        overlaps(other.startTime, other.endTime, reservation.startTime, reservation.endTime)
    )
    if (!occupied) return seat
  }
  return null
}

/**
 * Full snapshot of a facility's workstations for the staff UI.
 */
export async function getWorkstationSummary(
  db: Db,
  facilityId: string,
  now: Date = new Date()
): Promise<CbtfWorkstationSummary> {
  const facility = await loadFacility(db, facilityId)
  const statuses = facility.seatStatuses ?? []
  const disabled = getDisabledSeatNumbers(statuses, facility.totalSeats)
  const liveReservations: WorkstationReservation[] = await (
    db as any
  ).cbtfReservation.findMany({
    where: {
      facilityId,
      status: { in: ['SCHEDULED', 'CHECKED_IN'] },
      startTime: { lte: now },
      endTime: { gt: now }
    },
    include: {
      user: { select: { firstName: true, lastName: true } },
      assignment: { select: { title: true } }
    }
  })
  const atRiskRows: WorkstationReservation[] =
    disabled.length > 0
      ? await (db as any).cbtfReservation.findMany({
          where: {
            facilityId,
            seatNumber: { in: disabled },
            status: { in: ['SCHEDULED', 'CHECKED_IN'] },
            endTime: { gt: now }
          },
          include: {
            user: { select: { firstName: true, lastName: true } },
            assignment: { select: { title: true } }
          },
          orderBy: { startTime: 'asc' }
        })
      : []
  const counts = getSeatCapacityCounts(
    facility,
    disabled,
    liveReservations.map((reservation) => reservation.seatNumber)
  )
  const spares = getSpareSeatNumbers(facility, disabled)
  const disabledSet = new Set(disabled)
  const spareSet = new Set(spares)
  const occupancyBySeat = new Map<number, WorkstationReservation>()
  for (const reservation of liveReservations) {
    occupancyBySeat.set(reservation.seatNumber, reservation)
  }
  const statusBySeat = new Map(statuses.map((status) => [status.seatNumber, status]))
  const propertiesBySeat = new Map<number, string[]>(
    (facility.seats ?? []).map((seat) => [seat.seatNumber, seat.properties])
  )
  const seats: CbtfSeatStatusDto[] = getSeatOrder(facility).map((seatNumber) => {
    const status = statusBySeat.get(seatNumber)
    const current = occupancyBySeat.get(seatNumber)
    return {
      seatNumber,
      state: seatState(seatNumber, disabledSet, spareSet),
      reason: status?.reason ?? null,
      disabledAt: toIso(status?.disabledAt),
      properties: propertiesBySeat.get(seatNumber) ?? [],
      occupied: Boolean(current),
      currentReservation: current
        ? {
            reservationId: current.id,
            studentName: current.user
              ? `${current.user.firstName} ${current.user.lastName}`.trim()
              : '',
            assignmentTitle: current.assignment?.title ?? '',
            startTime: toIso(current.startTime) ?? '',
            endTime: toIso(current.endTime) ?? '',
            status: current.status as CbtfSeatOccupancyDto['status']
          }
        : null
    }
  })
  const workstationCounts: CbtfWorkstationCounts = {
    total: counts.total,
    working: counts.working,
    available: counts.available,
    spare: counts.spare,
    spareAvailable: counts.spareAvailable,
    outOfService: counts.outOfService
  }
  return {
    facilityId: facility.id,
    facilityName: facility.name,
    totalSeats: facility.totalSeats,
    spareSeatCount: facility.spareSeatCount ?? spares.length,
    spareSeatNumbers: spares,
    reassignThresholdMinutes: facility.reassignThresholdMinutes ?? 60,
    counts: workstationCounts,
    seats,
    atRisk: atRiskRows.map(toAtRisk)
  }
}

/**
 * Takes a workstation out of service. Existing reservations on the seat are
 * returned as "at risk"; staff move them explicitly from the at-risk list.
 */
export async function takeSeatOutOfService(
  db: Db,
  params: {
    facilityId: string
    seatNumber: number
    reason?: string
    userId: string
    now?: Date
  }
): Promise<SeatMutationResult> {
  const now = params.now ?? new Date()
  const facility = await loadFacility(db, params.facilityId)
  ensureSeatNumber(facility, params.seatNumber)

  await (db as any).cbtfSeatStatus.upsert({
    where: {
      facilityId_seatNumber: { facilityId: facility.id, seatNumber: params.seatNumber }
    },
    update: {
      isDisabled: true,
      reason: params.reason ?? null,
      disabledAt: now,
      updatedById: params.userId
    },
    create: {
      facilityId: facility.id,
      seatNumber: params.seatNumber,
      isDisabled: true,
      reason: params.reason ?? null,
      disabledAt: now,
      updatedById: params.userId
    }
  })

  const affected: WorkstationReservation[] = await (db as any).cbtfReservation.findMany({
    where: {
      facilityId: facility.id,
      seatNumber: params.seatNumber,
      status: { in: ['SCHEDULED', 'CHECKED_IN'] },
      endTime: { gt: now }
    },
    include: {
      user: { select: { firstName: true, lastName: true } },
      assignment: { select: { title: true } }
    },
    orderBy: { startTime: 'asc' }
  })

  const atRisk: CbtfAtRiskReservationDto[] = affected.map(toAtRisk)

  const summary = await getWorkstationSummary(db, facility.id, now)
  return { summary, moved: [], atRisk }
}

/** Returns a workstation to service. Already-in-service seats are a no-op. */
export async function returnSeatToService(
  db: Db,
  params: { facilityId: string; seatNumber: number; userId: string; now?: Date }
): Promise<{ summary: CbtfWorkstationSummary }> {
  const facility = await loadFacility(db, params.facilityId)
  ensureSeatNumber(facility, params.seatNumber)
  await (db as any).cbtfSeatStatus.deleteMany({
    where: { facilityId: facility.id, seatNumber: params.seatNumber }
  })
  const summary = await getWorkstationSummary(db, facility.id, params.now ?? new Date())
  return { summary }
}

/** Sets the number of spare seats (or resets the derived seat list). */
export async function configureSpareSeats(
  db: Db,
  params: { facilityId: string; spareSeatCount?: number | null; reset?: boolean }
): Promise<{ summary: CbtfWorkstationSummary }> {
  const facility = await loadFacility(db, params.facilityId)
  const total = facility.totalSeats

  let desired: number
  if (params.spareSeatCount === null) {
    desired = 0
  } else if (typeof params.spareSeatCount === 'number') {
    desired = params.spareSeatCount
  } else if (params.reset) {
    desired = facility.spareSeatCount ?? getRecommendedSpareSeatCount(total)
  } else {
    throw createError({ statusCode: 400, statusMessage: 'Provide spareSeatCount or reset' })
  }
  desired = Math.max(0, Math.min(total, Math.floor(desired)))
  const spareSeatNumbers =
    desired > 0 ? computeSpareSeatNumbers({ ...facility, spareSeatCount: desired }) : []

  await (db as any).cbtfFacility.update({
    where: { id: facility.id },
    data: { spareSeatCount: desired, spareSeatNumbers }
  })
  const summary = await getWorkstationSummary(db, facility.id)
  return { summary }
}

/**
 * Moves a reservation to another seat in the same facility.
 * Spare seats are preferred; any free in-service seat that meets the
 * student's accommodation may be used as a fallback.
 * Mid-exam (CHECKED_IN) reservations are allowed.
 */
export async function moveReservationToSeat(
  db: Db,
  params: {
    reservationId: string
    targetSeatNumber?: number
    userId: string
    now?: Date
  }
): Promise<CbtfReservationDto> {
  await lockCbtfFacilities(db as unknown as Prisma.TransactionClient)

  const reservation = await (db as any).cbtfReservation.findUnique({
    where: { id: params.reservationId },
    include: { facility: { include: { seats: true, seatStatuses: true } } }
  })
  if (!reservation) {
    throw createError({ statusCode: 404, statusMessage: 'Reservation not found' })
  }
  if (reservation.status !== 'SCHEDULED' && reservation.status !== 'CHECKED_IN') {
    throw createError({
      statusCode: 400,
      statusMessage: 'Only scheduled or checked-in reservations can be moved'
    })
  }
  const facility: WorkstationFacility = reservation.facility
  if (!facility) {
    throw createError({ statusCode: 404, statusMessage: 'Testing facility not found' })
  }

  const disabled = getDisabledSeatNumbers(facility.seatStatuses, facility.totalSeats)
  if (params.targetSeatNumber === undefined && !disabled.includes(reservation.seatNumber)) {
    throw createError({
      statusCode: 409,
      statusMessage: 'This reservation is already on an in-service seat'
    })
  }
  const candidates = getMoveCandidates(facility, disabled, reservation.seatNumber)
  const workingSeats = new Set(getWorkingSeatNumbers(facility, disabled))
  const accommodation = await (db as any).cbtfStudentAccommodation.findUnique({
    where: { userId: reservation.userId },
    select: { requiredSeatProperties: true, isActive: true }
  })
  const requiredProperties =
    accommodation?.isActive && Array.isArray(accommodation.requiredSeatProperties)
      ? accommodation.requiredSeatProperties
      : []
  const propertiesBySeat = new Map<number, string[]>(
    (facility.seats ?? []).map((seat) => [seat.seatNumber, seat.properties])
  )
  const others: WorkstationReservation[] = await (db as any).cbtfReservation.findMany({
    where: {
      facilityId: facility.id,
      status: { in: ['SCHEDULED', 'CHECKED_IN'] },
      id: { not: reservation.id }
    },
    select: {
      id: true,
      seatNumber: true,
      startTime: true,
      endTime: true,
      userId: true,
      facilityId: true,
      status: true
    }
  })

  let target: number | null = null
  if (params.targetSeatNumber !== undefined) {
    const candidate = params.targetSeatNumber
    if (!workingSeats.has(candidate)) {
      throw createError({ statusCode: 400, statusMessage: 'Target seat is out of service' })
    }
    if (!isSeatEligibleForStudent(propertiesBySeat.get(candidate) ?? [], requiredProperties)) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Target seat does not meet the student accommodation'
      })
    }
    const occupied = others.some(
      (other) =>
        other.seatNumber === candidate &&
        overlaps(other.startTime, other.endTime, reservation.startTime, reservation.endTime)
    )
    if (occupied) {
      throw createError({ statusCode: 409, statusMessage: 'Target seat is occupied for this time' })
    }
    target = candidate
  } else {
    target = pickTargetSeat({
      reservation,
      candidates,
      propertiesBySeat,
      requiredProperties,
      reservations: others
    })
    if (target == null) {
      throw createError({
        statusCode: 409,
        statusMessage: 'No other seat is available for this time'
      })
    }
  }

  if (target === reservation.seatNumber) {
    throw createError({ statusCode: 400, statusMessage: 'Reservation is already on this seat' })
  }

  const updated = await (db as any).cbtfReservation.update({
    where: { id: reservation.id },
    data: { seatNumber: target },
    include: {
      assignment: { select: { title: true } },
      facility: { select: { name: true } },
      user: {
        select: { firstName: true, lastName: true, email: true, studentId: true, avatarUrl: true }
      }
    }
  })
  await (db as any).cbtfReservationNote.create({
    data: {
      reservationId: reservation.id,
      authorId: params.userId,
      content: `Seat changed from ${reservation.seatNumber} to ${target}.`
    }
  })
  return toCbtfReservationDto(updated)
}
