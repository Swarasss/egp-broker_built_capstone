import { createError } from 'h3'
import type { Prisma } from '@prisma/client'
import { CBTF_DURATION_OPTIONS } from '@@/shared/utils/assignment-scheduling'
import { combineDateAndTime, getLocalDateString } from '@@/shared/utils/timezone'
import {
  calculateMaxArrivalsPerSlot,
  getEligibleSeatNumbers,
  getFacilityTimezone,
  resolveFacilityHours
} from './cbtf'
import { getAllocatableSeatNumbers, getDisabledSeatNumbers } from '@@/shared/utils/cbtf-seats'

const minimumExamMs = CBTF_DURATION_OPTIONS[0]!.value * 60_000

interface PlacementFacility {
  id: string
  name: string
  totalSeats: number
  eligibleSeats: number[]
  /** Effective (allocatable) seat count used for arrival throttling and occupancy. */
  arrivalCapacity?: number
  opensAt: Date
  closesAt: Date
}

interface PlacementReservation {
  facilityId: string
  seatNumber: number
  startTime: Date
  endTime: Date
}

interface Placement {
  facility: PlacementFacility
  seatNumber: number
  seatOrder: number
  fragmentation: number
  occupancy: number
  arrivalCongestion: number
  score: number
}

function comparePlacements(a: Placement, b: Placement): number {
  return (
    a.score - b.score ||
    a.fragmentation - b.fragmentation ||
    a.occupancy - b.occupancy ||
    a.arrivalCongestion - b.arrivalCongestion ||
    a.facility.id.localeCompare(b.facility.id) ||
    a.seatOrder - b.seatOrder
  )
}

export function scoreCbtfPlacements(
  facilities: PlacementFacility[],
  reservations: PlacementReservation[],
  startTime: Date,
  endTime: Date
): Placement | undefined {
  const byFacility = Map.groupBy(reservations, (reservation) => reservation.facilityId)
  let best: Placement | undefined

  for (const facility of facilities) {
    if (startTime < facility.opensAt || endTime > facility.closesAt) continue

    const existing = byFacility.get(facility.id) ?? []
    const effectiveCapacity = facility.arrivalCapacity ?? facility.totalSeats
    if (effectiveCapacity <= 0) continue
    const arrivalLimit = calculateMaxArrivalsPerSlot(effectiveCapacity)
    const arrivals = existing.filter((reservation) => +reservation.startTime === +startTime).length
    if (arrivals >= arrivalLimit) continue

    const occupied = new Set<number>()
    const freeBounds = new Map<number, { left: number; right: number }>()
    for (const reservation of existing) {
      const { startTime: start, endTime: end, seatNumber } = reservation
      if (start < endTime && end > startTime) {
        occupied.add(seatNumber)
        continue
      }
      const bounds = freeBounds.get(seatNumber) ?? {
        left: +facility.opensAt,
        right: +facility.closesAt
      }
      if (end <= startTime) bounds.left = Math.max(bounds.left, +end)
      if (start >= endTime) bounds.right = Math.min(bounds.right, +start)
      freeBounds.set(seatNumber, bounds)
    }

    const occupancy = Math.min(occupied.size, effectiveCapacity) / effectiveCapacity
    const arrivalCongestion = arrivals / arrivalLimit
    for (const [seatOrder, seatNumber] of facility.eligibleSeats.entries()) {
      if (occupied.has(seatNumber)) continue
      const bounds = freeBounds.get(seatNumber) ?? {
        left: +facility.opensAt,
        right: +facility.closesAt
      }
      const gaps = [+startTime - bounds.left, bounds.right - +endTime]
      const fragmentation = gaps
        .filter((gap) => gap > 0 && gap < minimumExamMs)
        .reduce((cost, gap) => cost + (minimumExamMs - gap) / minimumExamMs, 0)
      const candidate = {
        facility,
        seatNumber,
        seatOrder,
        fragmentation,
        occupancy,
        arrivalCongestion,
        score: fragmentation + occupancy + arrivalCongestion
      }
      if (!best || comparePlacements(candidate, best) < 0) best = candidate
    }
  }
  return best
}

/** Call inside a read-committed transaction before writing a student reservation. */
export async function lockCbtfFacilities(tx: Prisma.TransactionClient): Promise<string[]> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "CbtfFacility" ORDER BY id FOR UPDATE
  `
  return locked.map((facility) => facility.id)
}

export async function chooseCbtfPlacement(
  tx: Prisma.TransactionClient,
  facilityIds: string[],
  startTime: Date,
  endTime: Date,
  requiredSeatProperties: string[],
  excludeReservationId?: string,
  requiredSeatNumber?: number
): Promise<Placement> {
  const facilities = await tx.cbtfFacility.findMany({
    where: { id: { in: facilityIds } },
    include: { operatingHours: true, scheduleExceptions: true, seats: true, seatStatuses: true }
  })
  const feasible = facilities.flatMap((facility) => {
    const timezone = getFacilityTimezone(facility)
    const date = getLocalDateString(startTime, timezone)
    const hours = resolveFacilityHours(facility, date, timezone)
    if (!hours.openTime || !hours.closeTime || facility.totalSeats <= 0) return []
    const opensAt = combineDateAndTime(date, hours.openTime, timezone)
    const closesAt = combineDateAndTime(date, hours.closeTime, timezone)
    if (startTime < opensAt || endTime > closesAt) return []

    const disabledSeats = getDisabledSeatNumbers(facility.seatStatuses, facility.totalSeats)
    const allocatableSeats = getAllocatableSeatNumbers(facility, disabledSeats)
    const eligibleSeats = getEligibleSeatNumbers(
      allocatableSeats,
      new Map(facility.seats.map((seat) => [seat.seatNumber, seat.properties])),
      requiredSeatProperties
    ).filter((seatNumber) => requiredSeatNumber === undefined || seatNumber === requiredSeatNumber)
    return eligibleSeats.length
      ? [
          {
            ...facility,
            eligibleSeats,
            arrivalCapacity: allocatableSeats.length,
            opensAt,
            closesAt
          }
        ]
      : []
  })

  if (feasible.length) {
    const reservations = await tx.cbtfReservation.findMany({
      where: {
        facilityId: { in: feasible.map((facility) => facility.id) },
        status: { in: ['SCHEDULED', 'CHECKED_IN'] },
        ...(excludeReservationId ? { id: { not: excludeReservationId } } : {}),
        startTime: { lt: new Date(Math.max(...feasible.map((facility) => +facility.closesAt))) },
        endTime: { gt: new Date(Math.min(...feasible.map((facility) => +facility.opensAt))) }
      },
      select: { facilityId: true, startTime: true, endTime: true, seatNumber: true }
    })
    const best = scoreCbtfPlacements(feasible, reservations, startTime, endTime)
    if (best) return best
  }

  throw createError({
    statusCode: 409,
    statusMessage: 'No eligible workstation is available at this start time. Choose another time.'
  })
}
