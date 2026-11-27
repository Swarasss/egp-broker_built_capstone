/**
 * CBTF seat capacity helpers.
 *
 * A facility keeps a small number of seats open as "spare" seats so a student
 * can be moved if a workstation goes out of service. Spare seats are derived
 * automatically (default ~10% of seats, minimum 1) and can be overridden per
 * facility via `spareSeatCount` / `spareSeatNumbers`.
 *
 * Out-of-service seats (CbtfSeatStatus.isDisabled) are excluded from both
 * student scheduling and the spare pool until they are returned to service.
 */

export const DEFAULT_SPARE_SEAT_PERCENT = 0.1

export interface FacilitySeatConfig {
  totalSeats: number
  seatAllocationOrder?: unknown
  spareSeatCount?: number | null
  spareSeatNumbers?: unknown
}

export interface SeatCapacityCounts {
  /** Physical seats configured for the room. */
  total: number
  /** Seats that are not out of service. */
  working: number
  /** Seats students can be scheduled into (working minus spare). */
  available: number
  /** Seats kept open as spares. */
  spare: number
  /** Spare seats not currently occupied by a moved student. */
  spareAvailable: number
  /** Seats currently out of service. */
  outOfService: number
}

export interface SeatStatusLike {
  seatNumber: number
  isDisabled?: boolean | null
}

function toSeatNumber(raw: unknown): number | null {
  const seat = typeof raw === 'number' ? raw : Number(raw)
  return Number.isInteger(seat) ? seat : null
}

/** Normalizes an untrusted seat-number list to sorted, in-range, unique values. */
export function normalizeSeatNumbers(value: unknown, totalSeats: number): number[] {
  const total = Math.max(0, Math.floor(totalSeats))
  if (!Array.isArray(value)) return []
  const seats = new Set<number>()
  for (const raw of value) {
    const seat = toSeatNumber(raw)
    if (seat !== null && seat >= 1 && seat <= total) seats.add(seat)
  }
  return [...seats].sort((a, b) => a - b)
}

/** Physical seat numbers in allocation order (defaults to 1..totalSeats). */
export function getSeatOrder(facility: FacilitySeatConfig): number[] {
  const total = Math.max(0, Math.floor(facility.totalSeats))
  if (!Array.isArray(facility.seatAllocationOrder)) {
    return Array.from({ length: total }, (_, index) => index + 1)
  }
  const order: number[] = []
  const seen = new Set<number>()
  for (const raw of facility.seatAllocationOrder) {
    const seat = toSeatNumber(raw)
    if (seat !== null && seat >= 1 && seat <= total && !seen.has(seat)) {
      seen.add(seat)
      order.push(seat)
    }
  }
  return order.slice(0, total)
}

/** Recommended automatic spare count (10% of seats, minimum 1). */
export function getRecommendedSpareSeatCount(totalSeats: number): number {
  const total = Math.max(0, Math.floor(totalSeats))
  if (total === 0) return 0
  return Math.max(1, Math.min(total, Math.ceil(total * DEFAULT_SPARE_SEAT_PERCENT)))
}

/**
 * Configured spare count. Spares are opt-in: when unset (null/undefined) a
 * facility keeps its full capacity. New facilities are created with
 * `getRecommendedSpareSeatCount(...)` so spares are still automatic there.
 */
export function getSpareSeatCount(facility: FacilitySeatConfig): number {
  const total = Math.max(0, Math.floor(facility.totalSeats))
  if (total === 0) return 0
  const configured = facility.spareSeatCount
  if (configured == null) return 0
  return Math.max(0, Math.min(total, Math.floor(configured)))
}

/** Auto-derived spare seats: the last N seats in allocation order. */
export function computeSpareSeatNumbers(facility: FacilitySeatConfig): number[] {
  const count = getSpareSeatCount(facility)
  if (count <= 0) return []
  const order = getSeatOrder(facility)
  if (order.length === 0) return []
  return order.slice(Math.max(0, order.length - count))
}

/** Effective spare seats, excluding any that are out of service. */
export function getSpareSeatNumbers(
  facility: FacilitySeatConfig,
  disabledSeatNumbers?: unknown
): number[] {
  const orderSet = new Set(getSeatOrder(facility))
  const stored = normalizeSeatNumbers(facility.spareSeatNumbers, facility.totalSeats)
  const base = stored.length > 0 ? stored : computeSpareSeatNumbers(facility)
  const disabled = new Set(normalizeSeatNumbers(disabledSeatNumbers, facility.totalSeats))
  return base.filter((seat) => orderSet.has(seat) && !disabled.has(seat))
}

/** Seat numbers currently out of service. */
export function getDisabledSeatNumbers(
  statuses: readonly SeatStatusLike[] | null | undefined,
  totalSeats: number
): number[] {
  if (!statuses || statuses.length === 0) return []
  return normalizeSeatNumbers(
    statuses.filter((status) => status.isDisabled !== false).map((status) => status.seatNumber),
    totalSeats
  )
}

/** Seats that are not out of service. */
export function getWorkingSeatNumbers(
  facility: FacilitySeatConfig,
  disabledSeatNumbers?: unknown
): number[] {
  const disabled = new Set(normalizeSeatNumbers(disabledSeatNumbers, facility.totalSeats))
  return getSeatOrder(facility).filter((seat) => !disabled.has(seat))
}

/** Seats students can be scheduled into (working minus spare, excluding disabled). */
export function getAllocatableSeatNumbers(
  facility: FacilitySeatConfig,
  disabledSeatNumbers?: unknown
): number[] {
  const disabled = new Set(normalizeSeatNumbers(disabledSeatNumbers, facility.totalSeats))
  const spares = new Set(getSpareSeatNumbers(facility, disabledSeatNumbers))
  return getSeatOrder(facility).filter((seat) => !disabled.has(seat) && !spares.has(seat))
}

/** Capacity summary for display and scheduling. */
export function getSeatCapacityCounts(
  facility: FacilitySeatConfig,
  disabledSeatNumbers?: unknown,
  occupiedSeatNumbers?: unknown
): SeatCapacityCounts {
  const total = Math.max(0, Math.floor(facility.totalSeats))
  const disabled = normalizeSeatNumbers(disabledSeatNumbers, total)
  const occupied = new Set(normalizeSeatNumbers(occupiedSeatNumbers, total))
  const working = getWorkingSeatNumbers(facility, disabled)
  const spares = getSpareSeatNumbers(facility, disabled)
  const allocatable = getAllocatableSeatNumbers(facility, disabled)
  return {
    total,
    working: working.length,
    available: allocatable.length,
    spare: spares.length,
    spareAvailable: spares.filter((seat) => !occupied.has(seat)).length,
    outOfService: disabled.length
  }
}
