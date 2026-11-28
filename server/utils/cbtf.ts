/**
 * CBTF (Computer-Based Testing Facility) Core Engine
 *
 * Algorithms for operating hours, 5-minute slot generation, arrival throttling,
 * sequential seat allocation, retake pass windows, and progressive narrowing.
 */

import { createError } from 'h3'
import { isAllowedCbtfDuration } from '@@/shared/utils/assignment-scheduling'
import { getConfiguredCbtfSeatCount } from '@@/shared/utils/cbtf-capacity'
import {
  getAllocatableSeatNumbers,
  getDisabledSeatNumbers,
  getSpareSeatNumbers
} from '@@/shared/utils/cbtf-seats'
import type { Prisma, PrismaClient } from '@prisma/client'
import prisma from '@@/server/utils/db'
import { sendCbtfIncidentNotification } from './cbtf-notifications'
import { cbtfRetakeClaimSelect, cbtfRetakePassType, getOpenCbtfRetakeWindow } from './cbtf-retakes'
import {
  RECOMMENDATION_LOAD_WINDOW_MS,
  selectRecommendedStarts,
  type RecommendationCandidate,
  type RecommendationSeatCapacity
} from './cbtf-recommendations'
import type {
  CbtfFacility,
  CbtfFacilityAvailabilityStatus,
  CbtfReservationWindowStatus,
  CbtfReservation,
  CbtfRecommendedDay,
  CbtfHalfDayBlock,
  CbtfHourlySlotChoice,
  CbtfStudentBlock,
  CbtfStudentStart,
  CbtfSchedulingChoices,
  CbtfSchedulingPeriod,
  CbtfReservationDto
} from '@@/shared/models/cbtf'

import {
  DEFAULT_CBTF_TIMEZONE,
  getLocalDateString,
  extractCalendarDate,
  getLocalDayOfWeek,
  getLocalTimeParts,
  combineDateAndTime
} from '@@/shared/utils/timezone'

export interface FacilityOperatingHoursResult {
  isOpen: boolean
  openTime: string | null
  closeTime: string | null
  reason: string | null
}

export interface StudentSchedulingWindow {
  start: Date
  end: Date
  isPassWindow: boolean
  redemptionId: string | null
}

export interface SlotAvailability {
  startTime: Date
  endTime: Date
  arrivalsCount: number
  maxArrivals: number
  occupiedSeatsCount: number
  eligibleSeatCount: number
  occupiedEligibleSeatCount: number
  freeEligibleSeatCount: number
  totalSeats: number
}

/**
 * Returns the primary CBTF testing facility.
 */
export async function getPrimaryCbtfFacility(
  tx: PrismaClient | typeof prisma = prisma
): Promise<CbtfFacility & { operatingHours: any[]; scheduleExceptions: any[] }> {
  let facility = await (tx as any).cbtfFacility.findFirst({
    orderBy: { createdAt: 'asc' },
    include: {
      operatingHours: true,
      scheduleExceptions: true
    }
  })

  if (!facility) {
    // Auto-create default facility if none exists yet
    const seatOrder = Array.from({ length: 48 }, (_, i) => i + 1)
    facility = await (tx as any).cbtfFacility.create({
      data: {
        name: 'Main CBTF Facility',
        totalSeats: 48,
        seatAllocationOrder: seatOrder,
        operatingHours: {
          create: [
            { dayOfWeek: 1, openTime: '08:00', closeTime: '18:00' },
            { dayOfWeek: 2, openTime: '08:00', closeTime: '18:00' },
            { dayOfWeek: 3, openTime: '08:00', closeTime: '18:00' },
            { dayOfWeek: 4, openTime: '08:00', closeTime: '18:00' },
            { dayOfWeek: 5, openTime: '08:00', closeTime: '17:00' }
          ]
        }
      },
      include: {
        operatingHours: true,
        scheduleExceptions: true
      }
    })
  }

  return facility
}

export function getFacilityTimezone(facility?: { timezone?: string | null }): string {
  return facility?.timezone || DEFAULT_CBTF_TIMEZONE
}

/**
 * Resolves facility operating hours for a specific calendar date, checking exceptions first.
 * Evaluates day of week and date boundaries in the facility's local timezone.
 */
export async function getFacilityOperatingHoursForDate(
  facilityId: string,
  targetDate: Date,
  tx: PrismaClient | typeof prisma = prisma,
  timeZone: string = DEFAULT_CBTF_TIMEZONE
): Promise<FacilityOperatingHoursResult> {
  const localDateStr = extractCalendarDate(targetDate, timeZone)
  const startOfDay = new Date(`${localDateStr}T00:00:00.000Z`)
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000)

  // 1. Check schedule exception
  const exception = await (tx as any).cbtfScheduleException.findFirst({
    where: {
      facilityId,
      date: {
        gte: startOfDay,
        lt: endOfDay
      }
    }
  })

  if (exception) {
    if (exception.isClosed) {
      return {
        isOpen: false,
        openTime: null,
        closeTime: null,
        reason: exception.reason || 'Testing center closed for scheduled exception'
      }
    }
    if (exception.openTime && exception.closeTime) {
      return {
        isOpen: true,
        openTime: exception.openTime,
        closeTime: exception.closeTime,
        reason: exception.reason || null
      }
    }
  }

  // 2. Query weekly recurring operating hours (dayOfWeek in facility's timezone)
  const dayOfWeek = startOfDay.getUTCDay()
  const weeklyHours = await (tx as any).cbtfOperatingHours.findUnique({
    where: {
      facilityId_dayOfWeek: {
        facilityId,
        dayOfWeek
      }
    }
  })

  if (weeklyHours) {
    return {
      isOpen: true,
      openTime: weeklyHours.openTime,
      closeTime: weeklyHours.closeTime,
      reason: null
    }
  }

  return {
    isOpen: false,
    openTime: null,
    closeTime: null,
    reason: 'Testing center closed on this day of week'
  }
}

/** Resolves preloaded facility hours using the requested local calendar date. */
export function resolveFacilityHours(
  facility: {
    operatingHours: { dayOfWeek: number; openTime: string; closeTime: string }[]
    scheduleExceptions: {
      date: Date
      isClosed: boolean
      openTime: string | null
      closeTime: string | null
      reason: string | null
    }[]
  },
  date: string,
  timezone: string
): FacilityOperatingHoursResult {
  const exception = facility.scheduleExceptions.find(
    (item) => extractCalendarDate(item.date, timezone) === date
  )
  if (exception?.isClosed) {
    return { isOpen: false, openTime: null, closeTime: null, reason: exception.reason }
  }
  if (exception?.openTime && exception.closeTime) {
    return {
      isOpen: true,
      openTime: exception.openTime,
      closeTime: exception.closeTime,
      reason: exception.reason
    }
  }
  const dayOfWeek = new Date(date + 'T00:00:00Z').getUTCDay()
  const weekly = facility.operatingHours.find((item) => item.dayOfWeek === dayOfWeek)
  return {
    isOpen: !!weekly,
    openTime: weekly?.openTime ?? null,
    closeTime: weekly?.closeTime ?? null,
    reason: null
  }
}

/**
 * Calculates arrival throttling capacity: ceil(totalSeats / 12).
 */
export function calculateMaxArrivalsPerSlot(totalSeats: number): number {
  return Math.ceil(totalSeats / 12)
}

/** Eligible physical seats, in the facility's persisted allocation order. */
export function getFacilitySeatAllocationOrder(facility: {
  totalSeats: number
  seatAllocationOrder?: unknown
}): number[] {
  if (!Array.isArray(facility.seatAllocationOrder)) {
    return Array.from({ length: facility.totalSeats }, (_, i) => i + 1)
  }
  return [
    ...new Set(
      facility.seatAllocationOrder.filter(
        (seat): seat is number => Number.isInteger(seat) && seat > 0
      )
    )
  ].slice(0, facility.totalSeats)
}

/** Snapshot of a student's effective SSD accommodation. */
export interface StudentAccommodationSnapshot {
  timeMultiplier: number
  requiredSeatProperties: string[]
}

export const DEFAULT_STUDENT_ACCOMMODATION: StudentAccommodationSnapshot = {
  timeMultiplier: 1,
  requiredSeatProperties: []
}

/** Normalizes property tags so comparisons are case/whitespace insensitive. */
export function normalizeSeatProperties(properties?: readonly string[] | null): string[] {
  if (!properties) return []
  const normalized = properties
    .map((property) => property.trim().toUpperCase())
    .filter((property) => property.length > 0)
  return [...new Set(normalized)]
}

/**
 * A seat is eligible when it carries every property the student requires.
 * Students without requirements may only use uncertified seats, so certified
 * seats stay reserved for the students who need them.
 */
export function isSeatEligibleForStudent(
  seatProperties: readonly string[] | null | undefined,
  requiredProperties: readonly string[] | null | undefined
): boolean {
  const seat = normalizeSeatProperties(seatProperties)
  const required = normalizeSeatProperties(requiredProperties)
  if (required.length === 0) return seat.length === 0
  return required.every((property) => seat.includes(property))
}

/** Filters the facility allocation order down to seats the student may use. */
export function getEligibleSeatNumbers(
  seatAllocationOrder: number[],
  seatPropertiesByNumber: Map<number, string[]> | Record<number, string[]>,
  requiredProperties?: readonly string[] | null
): number[] {
  const getProperties = (seatNumber: number): string[] => {
    if (seatPropertiesByNumber instanceof Map) {
      return seatPropertiesByNumber.get(seatNumber) ?? []
    }
    return seatPropertiesByNumber[seatNumber] ?? []
  }
  return seatAllocationOrder.filter((seatNumber) =>
    isSeatEligibleForStudent(getProperties(seatNumber), requiredProperties)
  )
}

/**
 * Applies the accommodation's extra-time multiplier to an assignment duration,
 * rounding up to the next 5-minute scheduling boundary.
 */
export function getEffectiveExamDurationMinutes(
  baseDurationMinutes?: number | null,
  timeMultiplier?: number | null
): number {
  const base = baseDurationMinutes ?? 60
  if (!isAllowedCbtfDuration(base)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Assignment has an invalid CBTF exam duration',
      data: { availabilityStatus: 'INVALID_ASSIGNMENT_WINDOW' }
    })
  }
  const multiplier =
    Number.isFinite(timeMultiplier) && (timeMultiplier as number) >= 1
      ? (timeMultiplier as number)
      : 1
  return Math.ceil((base * multiplier) / 5) * 5
}

/** Loads the active accommodation for a student, falling back to no extra time. */
export async function getStudentAccommodation(
  userId: string,
  tx: Prisma.TransactionClient = prisma
): Promise<StudentAccommodationSnapshot> {
  const accommodation = await (tx as any).cbtfStudentAccommodation.findUnique({
    where: { userId },
    select: { timeMultiplier: true, requiredSeatProperties: true, isActive: true }
  })
  if (!accommodation || accommodation.isActive === false) {
    return { ...DEFAULT_STUDENT_ACCOMMODATION }
  }
  return {
    timeMultiplier: accommodation.timeMultiplier ?? 1,
    requiredSeatProperties: normalizeSeatProperties(accommodation.requiredSeatProperties)
  }
}

/** Loads certified seat properties for a facility, keyed by seat number. */
export async function getFacilitySeatProperties(
  facilityId: string,
  tx: PrismaClient | typeof prisma = prisma
): Promise<Map<number, string[]>> {
  const seats = await (tx as any).cbtfSeat.findMany({
    where: { facilityId },
    select: { seatNumber: true, properties: true }
  })
  return new Map(
    (seats as { seatNumber: number; properties: string[] }[]).map((seat) => [
      seat.seatNumber,
      normalizeSeatProperties(seat.properties)
    ])
  )
}

const cbtfStartStepMs = 5 * 60_000

function getCbtfDayBounds(
  date: Date | string,
  hours: FacilityOperatingHoursResult,
  timezone: string,
  durationMinutes: number,
  examWindow?: Pick<StudentSchedulingWindow, 'start' | 'end'>
) {
  const validTime = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/
  if (
    !hours.isOpen ||
    !hours.openTime ||
    !hours.closeTime ||
    !validTime.test(hours.openTime) ||
    !validTime.test(hours.closeTime) ||
    hours.openTime >= hours.closeTime
  )
    return

  const start = Math.max(
    +combineDateAndTime(date, hours.openTime, timezone),
    examWindow?.start.getTime() ?? -Infinity
  )
  const end = Math.min(
    +combineDateAndTime(date, hours.closeTime, timezone),
    examWindow?.end.getTime() ?? Infinity
  )
  if (end <= start) return
  return {
    firstStart: Math.ceil(start / cbtfStartStepMs) * cbtfStartStepMs,
    latestStart: end - durationMinutes * 60_000
  }
}

/**
 * Generates available 5-minute boundary slots for a given date,
 * filtering out throttled slots and capacity-exceeded slots.
 * Open and close times are interpreted in the facility's local timezone.
 */
export function generateAvailableSlotsForDate(
  facility: { totalSeats: number; timezone?: string; seatAllocationOrder?: unknown },
  targetDate: Date,
  hours: FacilityOperatingHoursResult,
  existingReservations: { startTime: Date; endTime: Date; seatNumber: number }[],
  timeZone: string = facility.timezone || DEFAULT_CBTF_TIMEZONE,
  durationMinutes: number = 60,
  examWindow?: Pick<StudentSchedulingWindow, 'start' | 'end'>,
  eligibleSeatNumbers?: number[],
  futureCapacity?: { now: Date; hasFreeSeat: boolean },
  throttleSeatCount?: number
): SlotAvailability[] {
  const bounds = getCbtfDayBounds(targetDate, hours, timeZone, durationMinutes, examWindow)
  if (!bounds) return []

  const maxArrivals = calculateMaxArrivalsPerSlot(throttleSeatCount ?? facility.totalSeats)
  const availableSlots: SlotAvailability[] = []
  const durationMs = durationMinutes * 60_000

  const seatOrder = getFacilitySeatAllocationOrder(facility)
  const eligibleSeatSet = eligibleSeatNumbers ? new Set(eligibleSeatNumbers) : null
  const availableSeatOrder = eligibleSeatSet
    ? seatOrder.filter((seat) => eligibleSeatSet.has(seat))
    : seatOrder

  const firstStart = futureCapacity
    ? Math.max(
        bounds.firstStart,
        Math.ceil(+futureCapacity.now / cbtfStartStepMs) * cbtfStartStepMs
      )
    : bounds.firstStart
  for (let currentMs = firstStart; currentMs <= bounds.latestStart; currentMs += cbtfStartStepMs) {
    const slotStart = new Date(currentMs)
    const slotEnd = new Date(currentMs + durationMs)

    // 1. Arrival throttle: count reservations starting at exact slotStart
    const arrivalsCount = existingReservations.filter(
      (r) => r.startTime.getTime() === slotStart.getTime()
    ).length

    // 2. Active seat occupancy: count reservations overlapping [slotStart, slotEnd)
    const activeReservations = existingReservations.filter(
      (r) => r.startTime.getTime() < slotEnd.getTime() && r.endTime.getTime() > slotStart.getTime()
    )

    const isThrottleOk = arrivalsCount < maxArrivals
    const occupiedSeats = new Set(activeReservations.map((reservation) => reservation.seatNumber))
    const eligibleSeatCount = availableSeatOrder.length
    const occupiedEligibleSeatCount = availableSeatOrder.filter((seat) =>
      occupiedSeats.has(seat)
    ).length
    const freeEligibleSeatCount = eligibleSeatCount - occupiedEligibleSeatCount

    if (futureCapacity && freeEligibleSeatCount > 0) {
      futureCapacity.hasFreeSeat = true
    }

    if (isThrottleOk && freeEligibleSeatCount > 0) {
      availableSlots.push({
        startTime: slotStart,
        endTime: slotEnd,
        arrivalsCount,
        maxArrivals,
        occupiedSeatsCount: occupiedSeats.size,
        eligibleSeatCount,
        occupiedEligibleSeatCount,
        freeEligibleSeatCount,
        totalSeats: facility.totalSeats
      })
    }
  }

  return availableSlots
}

/**
 * Calculates the slice of seat indices in seatAllocationOrder for a 5-minute arrival offset (0..11).
 * Partitions totalSeats into 12 contiguous blocks, distributing remainder seats to the earliest offsets.
 */
export function getOffsetSeatIndices(
  totalSeats: number,
  offset: number
): { startIndex: number; count: number } {
  if (totalSeats <= 0) {
    return { startIndex: 0, count: 0 }
  }
  const baseCount = Math.floor(totalSeats / 12)
  const remainder = totalSeats % 12
  const normalizedOffset = Math.max(0, Math.min(11, offset))

  const startIndex = normalizedOffset * baseCount + Math.min(normalizedOffset, remainder)
  const count = baseCount + (normalizedOffset < remainder ? 1 : 0)

  return { startIndex, count }
}

/**
 * Assigns the next available seat number based on the student's 5-minute arrival time offset.
 * Maps the 5-minute offset (:00, :05, ..., :55) to contiguous slices of seatAllocationOrder.
 * If all primary seats for the offset are occupied, gracefully overflows in circular order.
 * `eligibleSeatNumbers` restricts allocation to seats that meet a student's accommodations.
 */
export function assignNextSeat(
  seatAllocationOrder: number[],
  slotStart: Date,
  slotEnd: Date,
  activeReservationsInWindow: { seatNumber: number }[],
  _lastAssignedSeat?: number | null,
  eligibleSeatNumbers?: number[] | null
): number {
  if (!seatAllocationOrder || seatAllocationOrder.length === 0) {
    throw createError({
      statusCode: 500,
      statusMessage: 'Facility seat allocation order is not configured'
    })
  }

  const effectiveOrder = eligibleSeatNumbers
    ? seatAllocationOrder.filter((seat) => eligibleSeatNumbers.includes(seat))
    : seatAllocationOrder

  if (effectiveOrder.length === 0) {
    throw createError({
      statusCode: 409,
      statusMessage: 'No seats are available that meet this student\'s accommodations'
    })
  }

  const occupiedSeats = new Set(activeReservationsInWindow.map((r) => r.seatNumber))
  const totalSeats = effectiveOrder.length

  // Calculate 5-minute arrival offset (0 for :00, 1 for :05, ..., 11 for :55)
  const minute = slotStart.getUTCMinutes()
  const offset = Math.floor(minute / 5)

  const { startIndex, count } = getOffsetSeatIndices(totalSeats, offset)

  // 1. First priority: Check primary candidate seats assigned to this 5-minute offset
  for (let i = 0; i < count; i++) {
    const candidateSeat = effectiveOrder[startIndex + i]
    if (candidateSeat !== undefined && !occupiedSeats.has(candidateSeat)) {
      return candidateSeat
    }
  }

  // 2. Fallback: If all primary seats for this offset are occupied, check remaining seats in circular order
  for (let i = 0; i < totalSeats; i++) {
    const candidateSeat = effectiveOrder[(startIndex + count + i) % totalSeats]
    if (candidateSeat !== undefined && !occupiedSeats.has(candidateSeat)) {
      return candidateSeat
    }
  }

  throw createError({
    statusCode: 409,
    statusMessage: 'No unallocated seats available at this time slot'
  })
}

/**
 * Checks when a student may create or change a booking, independently of exam dates.
 */
export function getCbtfReservationWindowStatus(
  assignment: { scheduleWindowStart: Date | null; scheduleWindowEnd: Date | null },
  now = new Date()
): CbtfReservationWindowStatus {
  const { scheduleWindowStart: start, scheduleWindowEnd: end } = assignment
  if (!start || !end || start >= end || now > end) return 'CLOSED'
  return now < start ? 'NOT_YET_OPEN' : 'OPEN'
}

const cbtfRetakeMessages = {
  RETAKE_PASS_REQUIRED: 'You have already completed this exam. A retake pass is required to schedule another attempt.',
  RETAKE_WINDOW_EXPIRED: 'There is no usable retake window for this booking.'
} as const

type RetakeBlock = keyof typeof cbtfRetakeMessages

interface CbtfSchedulingState {
  examWindow: StudentSchedulingWindow
  actionWindow: { scheduleWindowStart: Date | null; scheduleWindowEnd: Date | null }
  actionStatus: CbtfReservationWindowStatus
  retakeBlock: RetakeBlock | null
  reusableRetakeId: string | null
}

export function assertCbtfSchedulingOpen(state: CbtfSchedulingState) {
  if (state.retakeBlock) {
    throw createError({
      statusCode: 403,
      statusMessage: cbtfRetakeMessages[state.retakeBlock],
      data: { availabilityStatus: state.retakeBlock }
    })
  }
  if (state.actionStatus !== 'OPEN') {
    throw createError({
      statusCode: 403,
      statusMessage: 'Reservations can only be created or changed during the Reservation Window'
    })
  }
}

/** Resolve booking eligibility and both student-specific windows from the same receipt. */
export async function getCbtfSchedulingState(
  userId: string,
  assignment: {
    id: string
    courseId?: string
    scheduleWindowStart: Date | null
    scheduleWindowEnd: Date | null
    availableFrom: Date | null
    acceptUntil: Date | null
  },
  tx: Prisma.TransactionClient = prisma,
  reservation?: { id: string; retakeRedemptionId: string | null } | null,
  now = new Date()
): Promise<CbtfSchedulingState> {
  const pinnedRedemptionId = reservation?.retakeRedemptionId
  const receipts = await tx.passRedemption.findMany({
    where: {
      ...(pinnedRedemptionId ? { id: pinnedRedemptionId } : {}),
      assignmentId: assignment.id,
      pool: { userId, passType: { ...cbtfRetakePassType, courseId: assignment.courseId } }
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: { cbtfRetake: { select: cbtfRetakeClaimSelect } }
  })

  for (const receipt of receipts) {
    const window = getOpenCbtfRetakeWindow(receipt, now, reservation?.id)
    if (!window) continue
    return {
      examWindow: { ...window, isPassWindow: true, redemptionId: receipt.id },
      actionWindow: { scheduleWindowStart: window.start, scheduleWindowEnd: window.end },
      actionStatus: 'OPEN',
      retakeBlock: null,
      reusableRetakeId: receipt.cbtfRetake?.id ?? null
    }
  }

  const completed = await tx.cbtfReservation.findFirst({
    where: {
      userId,
      assignmentId: assignment.id,
      status: { in: ['CHECKED_OUT', 'COMPLETED'] }
    },
    select: { id: true }
  })
  const actionStatus = getCbtfReservationWindowStatus(assignment, now)
  let retakeBlock: RetakeBlock | null = null
  if (pinnedRedemptionId || (receipts.length && (completed || actionStatus !== 'OPEN'))) {
    retakeBlock = 'RETAKE_WINDOW_EXPIRED'
  } else if (completed) {
    retakeBlock = 'RETAKE_PASS_REQUIRED'
  }

  const { availableFrom: start, acceptUntil: end, scheduleWindowStart, scheduleWindowEnd } = assignment
  if (!start || !end || end <= start) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Assignment must have a valid Available From / Accept Until exam window',
      data: { availabilityStatus: 'INVALID_ASSIGNMENT_WINDOW' }
    })
  }

  return {
    examWindow: { start, end, isPassWindow: false, redemptionId: null },
    actionWindow: { scheduleWindowStart, scheduleWindowEnd },
    actionStatus,
    retakeBlock,
    reusableRetakeId: null
  }
}

export const CBTF_AFTERNOON_DIVIDING_TIME = '12:30'
export const CBTF_AFTERNOON_DIVIDING_HOUR = 12.5 // 12:30 PM

/** Arrival ranges use the filtered five-minute candidates, before recommendation sampling. */
function formatArrivalRange(slots: SlotAvailability[], timeZone: string): string {
  const first = getLocalTimeParts(slots[0]!.startTime, timeZone).formattedTime
  const last = getLocalTimeParts(slots[slots.length - 1]!.startTime, timeZone).formattedTime
  return `${first} – ${last}`
}

const schedulingPeriods = ['morning', 'afternoon'] as const
const maxSuggestedDays = 4

type FacilitySchedulingDay = {
  date: string
  label: string
  candidates: RecommendationCandidate[]
}

type FacilitySchedulingDays = Record<CbtfSchedulingPeriod, FacilitySchedulingDay[]>

function mergeSchedulingChoices(
  facilities: {
    schedulingDays: FacilitySchedulingDays
    accumulateCapacity: (
      starts: Set<number>,
      capacity: Map<number, RecommendationSeatCapacity[]>
    ) => void
  }[],
  reservations: readonly Pick<CbtfReservation, 'startTime'>[],
  studentId: string,
  assignmentId: string
): CbtfSchedulingChoices {
  const daysByPeriod = {
    morning: new Map<string, FacilitySchedulingDay>(),
    afternoon: new Map<string, FacilitySchedulingDay>()
  }
  for (const period of schedulingPeriods) {
    const days = daysByPeriod[period]
    for (const facility of facilities) {
      for (const day of facility.schedulingDays[period]) {
        const merged = days.get(day.date) ?? { ...day, candidates: [] }
        merged.candidates.push(...day.candidates)
        days.set(day.date, merged)
      }
    }
  }

  const latestDays = (period: CbtfSchedulingPeriod) =>
    [...daysByPeriod[period].values()]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, maxSuggestedDays)
  const morning = latestDays('morning')
  const afternoon = latestDays('afternoon')
  const starts = new Set<number>()
  for (const day of [...morning, ...afternoon]) {
    for (const candidate of day.candidates) starts.add(+candidate.startTime)
  }

  const capacity = new Map<number, RecommendationSeatCapacity[]>()
  for (const facility of facilities) facility.accumulateCapacity(starts, capacity)
  const arrivals = new Map<number, number>()
  for (const { startTime } of reservations) {
    const timestamp = +startTime
    arrivals.set(timestamp, (arrivals.get(timestamp) ?? 0) + 1)
  }

  const recommendTimes = ({ date, label, candidates }: FacilitySchedulingDay) => ({
    date,
    label,
    times: selectRecommendedStarts(candidates, arrivals, capacity, studentId, assignmentId).map(
      ({ startTime, endTime, timezone }) => ({
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        timezone,
        formattedTime: getLocalTimeParts(startTime, timezone).formattedTime
      })
    )
  })
  return { morning: morning.map(recommendTimes), afternoon: afternoon.map(recommendTimes) }
}

/** Unions timestamps across centers that share a local calendar and half-day block. */
export async function getAllFacilitiesAvailability(
  studentWindow: StudentSchedulingWindow,
  preferenceOrBlockId?: string,
  selectedDateStr?: string,
  tx: PrismaClient | typeof prisma = prisma,
  durationMinutes: number = 60,
  excludeReservationId?: string,
  requiredSeatProperties: string[] = [],
  studentId?: string,
  now = new Date(),
  narrowingAssignmentId?: string
) {
  const narrowing = narrowingAssignmentId !== undefined
  const searchStart = Math.max(+studentWindow.start, +now)
  const loadPadding = narrowing ? RECOMMENDATION_LOAD_WINDOW_MS : 0
  const facilities = await tx.cbtfFacility.findMany({
    orderBy: { id: 'asc' },
    include: { operatingHours: true, scheduleExceptions: true, seats: true, seatStatuses: true }
  })
  const configuredTotalSeats = getConfiguredCbtfSeatCount(facilities)
  const reservations = facilities.length
    ? await tx.cbtfReservation.findMany({
        where: {
          facilityId: { in: facilities.map((facility) => facility.id) },
          status: { in: ['SCHEDULED', 'CHECKED_IN'] },
          ...(excludeReservationId ? { id: { not: excludeReservationId } } : {}),
          startTime: { lt: new Date(+studentWindow.end + loadPadding) },
          endTime: { gt: new Date(searchStart - loadPadding) }
        },
        select: { facilityId: true, startTime: true, endTime: true, seatNumber: true, userId: true }
      })
    : []
  // Padded rows contribute to arrival load only. Keep the original feasibility predicates.
  const feasibilityReservations = narrowing
    ? reservations.filter(
        (reservation) =>
          +reservation.startTime < +studentWindow.end && +reservation.endTime > searchStart
      )
    : reservations
  const studentReservations = studentId
    ? feasibilityReservations.filter((reservation) => reservation.userId === studentId)
    : []
  const byFacility = Map.groupBy(feasibilityReservations, (reservation) => reservation.facilityId)
  const [blockId, blockTimezone] = preferenceOrBlockId?.split(':') ?? []
  const results = await Promise.all(
    facilities.map(async (facility) => {
      const timezone = getFacilityTimezone(facility)
      const disabledSeats = getDisabledSeatNumbers(facility.seatStatuses, facility.totalSeats)
      const allocatableSeats = getAllocatableSeatNumbers(facility, disabledSeats)
      const eligibleSeats = getEligibleSeatNumbers(
        allocatableSeats,
        new Map(facility.seats.map((seat) => [seat.seatNumber, seat.properties])),
        requiredSeatProperties
      )
      const result = await getRecommendedDaysAndSlots(
        facility,
        studentWindow,
        blockId,
        selectedDateStr,
        tx,
        durationMinutes,
        excludeReservationId,
        eligibleSeats,
        byFacility.get(facility.id) ?? [],
        studentReservations,
        now,
        narrowing,
        allocatableSeats.length
      )
      return { ...result, timezone, facilityId: facility.id, facilityName: facility.name }
    })
  )

  const blocks = new Map<string, CbtfStudentBlock>()
  const slots = new Map<string, CbtfStudentStart>()
  for (const result of results) {
    const { timezone } = result
    for (const block of result.blocks) {
      const id = `${block.id}:${timezone}`
      blocks.set(id, {
        id,
        label: block.label,
        dateLabel: block.dateLabel,
        timezone,
        isCurrentBlock: block.isCurrentBlock || (blocks.get(id)?.isCurrentBlock ?? false)
      })
    }
    if (blockTimezone && timezone !== blockTimezone) continue
    for (const slot of result.hourlySlots) {
      const { startTime, endTime, formattedTime } = slot
      slots.set(startTime, { startTime, endTime, formattedTime })
    }
  }
  const statuses = new Set(results.map((result) => result.status))
  const availabilityStatus: CbtfFacilityAvailabilityStatus =
    (
      [
        'AVAILABLE',
        'STUDENT_CONFLICT',
        'ARRIVAL_LIMIT_REACHED',
        'NO_AVAILABLE_SEATS',
        'NO_FUTURE_STARTS'
      ] as const
    ).find((status) => statuses.has(status)) ?? 'NO_CONFIGURED_FACILITY_HOURS'
  return {
    availabilityStatus,
    facilityDiagnostics: results.map(({ facilityId, facilityName, status }) => ({
      facilityId,
      facilityName,
      status
    })),
    configuredTotalSeats,
    ...(narrowingAssignmentId !== undefined
      ? {
          schedulingChoices: mergeSchedulingChoices(
            results,
            reservations,
            studentId ?? '',
            narrowingAssignmentId
          )
        }
      : {}),
    blocks: [...blocks.values()].sort(
      (a, b) =>
        a.id.slice(0, 10).localeCompare(b.id.slice(0, 10)) ||
        a.timezone.localeCompare(b.timezone) ||
        Number(b.id.includes('-morning:')) - Number(a.id.includes('-morning:'))
    ),
    recommendedDays: results.flatMap((result) => result.recommendedDays),
    hourlySlots: [...slots.values()].sort((a, b) => a.startTime.localeCompare(b.startTime))
  }
}

/**
 * Half-Day Block Scheduling Algorithm:
 * - Divides days at 12:30 PM (12:30) into Morning and Afternoon blocks.
 * - Offers the next 4 half-day blocks when slots are open.
 * - If a half-day block is currently in progress, includes it plus the next 4.
 * - If all evaluated blocks have utilization > 75%, offers the next 5 blocks instead of 4.
 * - Highlights blocks with utilization > 60%.
 */
export async function getRecommendedDaysAndSlots(
  facility: CbtfFacility & { operatingHours: any[]; scheduleExceptions: any[]; timezone?: string },
  studentWindow: StudentSchedulingWindow,
  preferenceOrBlockId?: string,
  selectedDateStr?: string,
  tx: Prisma.TransactionClient = prisma,
  durationMinutes: number = 60,
  excludeReservationId?: string,
  eligibleSeatNumbers?: number[],
  preloadedReservations?: Pick<CbtfReservation, 'startTime' | 'endTime' | 'seatNumber'>[],
  studentReservations: Pick<CbtfReservation, 'startTime' | 'endTime'>[] = [],
  now = new Date(),
  narrowing = false,
  throttleSeatCount?: number
): Promise<{
  status: CbtfFacilityAvailabilityStatus
  blocks: CbtfHalfDayBlock[]
  recommendedDays: CbtfRecommendedDay[]
  hourlySlots: CbtfHourlySlotChoice[]
  schedulingDays: FacilitySchedulingDays
  accumulateCapacity: (
    starts: Set<number>,
    capacity: Map<number, RecommendationSeatCapacity[]>
  ) => void
}> {
  const timeZone = facility.timezone || DEFAULT_CBTF_TIMEZONE
  const searchStart = new Date(Math.max(studentWindow.start.getTime(), now.getTime()))
  const searchEnd = new Date(studentWindow.end)

  // Fetch all active reservations in the window once to avoid N+1 queries
  const allReservations =
    preloadedReservations ??
    (await tx.cbtfReservation.findMany({
      where: {
        facilityId: facility.id,
        status: { in: ['SCHEDULED', 'CHECKED_IN'] },
        ...(excludeReservationId ? { id: { not: excludeReservationId } } : {}),
        startTime: { lt: searchEnd },
        endTime: { gt: searchStart }
      },
      select: {
        startTime: true,
        endTime: true,
        seatNumber: true
      }
    }))

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const monthNames = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec'
  ]

  const candidateBlockItems: {
    block: CbtfHalfDayBlock
    openSlots: SlotAvailability[]
  }[] = []

  const hourFormatter = narrowing
    ? new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' })
    : null
  const schedulingDays: FacilitySchedulingDays = {
    morning: [],
    afternoon: []
  }

  // Scan facility-local dates in the exam window, retaining the legacy horizon for legacy callers.
  const localStartDateStr = getLocalDateString(searchStart, timeZone)
  const localEndDateStr = getLocalDateString(searchEnd, timeZone)
  const firstDate = preloadedReservations
    ? getLocalDateString(studentWindow.start, timeZone)
    : localStartDateStr
  const startParts = (narrowing ? localEndDateStr : firstDate).split('-').map(Number)
  const cursorDate = new Date(Date.UTC(startParts[0], startParts[1] - 1, startParts[2]))
  const advanceDate = () => cursorDate.setUTCDate(cursorDate.getUTCDate() + (narrowing ? -1 : 1))
  const maxDays = 30
  let daysScanned = 0

  let hasOverlappingHours = false
  let hasFutureStarts = false
  let hasConflict = false
  const futureCapacity = { now, hasFreeSeat: false }
  const targetDate = preferenceOrBlockId?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? selectedDateStr

  const slotsByDate = new Map<string, SlotAvailability[]>()
  const withinStudentWindow = (slot: SlotAvailability) =>
    slot.startTime >= studentWindow.start && slot.endTime <= studentWindow.end

  const slotsForDay = (
    date: string,
    dayStartUtc: Date,
    dayEndUtc: Date,
    hours: FacilityOperatingHoursResult
  ) => {
    const cached = slotsByDate.get(date)
    if (cached) return cached
    const dayReservations = allReservations.filter(
      (reservation) => reservation.startTime <= dayEndUtc && reservation.endTime > dayStartUtc
    )
    const slots = generateAvailableSlotsForDate(
      facility,
      dayStartUtc,
      hours,
      dayReservations,
      timeZone,
      durationMinutes,
      studentWindow,
      eligibleSeatNumbers,
      futureCapacity,
      throttleSeatCount
    ).filter((slot) => {
      if (!withinStudentWindow(slot) || slot.startTime < now) return false
      const overlaps = studentReservations.some(
        (reservation) =>
          reservation.startTime < slot.endTime && reservation.endTime > slot.startTime
      )
      hasConflict ||= overlaps
      return !overlaps
    })
    if (narrowing) slotsByDate.set(date, slots)
    return slots
  }

  const accumulateCapacity = (
    starts: Set<number>,
    capacity: Map<number, RecommendationSeatCapacity[]>
  ) => {
    if (!starts.size || eligibleSeatNumbers?.length === 0) return
    const dateFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
    const dates = new Set<string>()
    for (const timestamp of starts) dates.add(dateFormatter.format(timestamp))
    for (const date of dates) {
      // A start can be on another local date or in another period at this facility.
      const slots =
        slotsByDate.get(date) ??
        slotsForDay(
          date,
          combineDateAndTime(date, '00:00', timeZone),
          combineDateAndTime(date, '23:59', timeZone),
          resolveFacilityHours(facility, date, timeZone)
        )
      for (const slot of slots) {
        const timestamp = +slot.startTime
        if (!starts.has(timestamp)) continue
        const feasible = capacity.get(timestamp) ?? []
        feasible.push(slot)
        capacity.set(timestamp, feasible)
      }
    }
  }

  while (
    preloadedReservations
      ? facility.operatingHours.length || facility.scheduleExceptions.length
      : daysScanned < maxDays
  ) {
    daysScanned++
    const dateStr = cursorDate.toISOString().split('T')[0]
    if (narrowing ? dateStr < firstDate : dateStr > localEndDateStr) {
      break
    }

    if (
      narrowing &&
      schedulingPeriods.every((period) => schedulingDays[period].length >= maxSuggestedDays)
    )
      break

    // Six blocks are enough for the existing display policy. Continue through any explicitly requested date.
    if (
      !narrowing &&
      preloadedReservations &&
      candidateBlockItems.length >= 6 &&
      (!targetDate || dateStr > targetDate)
    )
      break

    const dayStartUtc = combineDateAndTime(dateStr, '00:00', timeZone)
    const dayEndUtc = combineDateAndTime(dateStr, '23:59', timeZone)

    const hours = preloadedReservations
      ? resolveFacilityHours(facility, dateStr, timeZone)
      : await getFacilityOperatingHoursForDate(
          facility.id,
          dayStartUtc,
          tx as PrismaClient,
          timeZone
        )

    const bounds = getCbtfDayBounds(dateStr, hours, timeZone, durationMinutes, studentWindow)
    hasOverlappingHours ||= !!bounds

    if (preloadedReservations && dateStr < localStartDateStr) {
      if (narrowing && hasOverlappingHours) break
      if (!narrowing && hasOverlappingHours) {
        cursorDate.setTime(Date.parse(localStartDateStr + 'T00:00:00Z'))
      } else {
        advanceDate()
      }
      continue
    }

    if (bounds && hours.openTime && hours.closeTime) {
      const firstFutureStart = Math.max(
        bounds.firstStart,
        Math.ceil(+now / cbtfStartStepMs) * cbtfStartStepMs
      )
      if (firstFutureStart > bounds.latestStart) {
        advanceDate()
        continue
      }
      hasFutureStarts = true
      if (eligibleSeatNumbers?.length === 0) break
      const afternoonDividingUtc = combineDateAndTime(
        dateStr,
        CBTF_AFTERNOON_DIVIDING_TIME,
        timeZone
      )
      if (
        narrowing &&
        ((bounds.latestStart < +afternoonDividingUtc &&
          schedulingDays.morning.length >= maxSuggestedDays) ||
          (firstFutureStart >= +afternoonDividingUtc &&
            schedulingDays.afternoon.length >= maxSuggestedDays))
      ) {
        advanceDate()
        continue
      }

      const allSlots = slotsForDay(dateStr, dayStartUtc, dayEndUtc, hours)

      const dayOfWeek = getLocalDayOfWeek(dayStartUtc, timeZone)
      const dayName = dayNames[dayOfWeek]
      const localMonth = cursorDate.getUTCMonth()
      const localDayNum = cursorDate.getUTCDate()
      const monthName = monthNames[localMonth]
      const dateLabel = `${monthName} ${localDayNum}`

      if (hourFormatter) {
        const candidates: Record<CbtfSchedulingPeriod, RecommendationCandidate[]> = {
          morning: [],
          afternoon: []
        }
        for (const { startTime, endTime } of allSlots) {
          const period = startTime < afternoonDividingUtc ? 'morning' : 'afternoon'
          if (schedulingDays[period].length >= maxSuggestedDays) continue
          candidates[period].push({
            startTime,
            endTime,
            timezone: timeZone,
            hour: Number(hourFormatter.format(startTime))
          })
        }
        for (const period of schedulingPeriods) {
          if (candidates[period].length) {
            schedulingDays[period].push({
              date: dateStr,
              label: `${dayName.slice(0, 3)}, ${dateLabel}`,
              candidates: candidates[period]
            })
          }
        }
        advanceDate()
        continue
      }

      const theoreticalSlots = generateAvailableSlotsForDate(
        facility,
        dayStartUtc,
        hours,
        [],
        timeZone,
        durationMinutes,
        studentWindow,
        eligibleSeatNumbers,
        undefined,
        throttleSeatCount
      ).filter(withinStudentWindow)
      // Morning block: openTime until 12:30
      if (hours.openTime < CBTF_AFTERNOON_DIVIDING_TIME) {
        const blockStart = combineDateAndTime(dateStr, hours.openTime, timeZone)
        const blockEnd = afternoonDividingUtc
        const theoreticalBlockSlots = theoreticalSlots.filter(
          (s) => s.startTime < afternoonDividingUtc
        )
        const openSlots = allSlots.filter(
          (s) => s.startTime < afternoonDividingUtc && s.startTime >= now
        )

        if (openSlots.length > 0) {
          const isCurrentBlock = now >= blockStart && now < blockEnd
          const totalSlotsCount = theoreticalBlockSlots.length
          const openSlotsCount = openSlots.length
          const utilizationPercentage =
            totalSlotsCount > 0
              ? Math.max(
                  0,
                  Math.min(
                    100,
                    Math.round(((totalSlotsCount - openSlotsCount) / totalSlotsCount) * 100)
                  )
                )
              : 100

          candidateBlockItems.push({
            block: {
              facilityId: facility.id,
              facilityName: facility.name,
              totalSeats: facility.totalSeats,
              id: `${dateStr}-morning`,
              date: dateStr,
              dayOfWeek,
              blockType: 'morning',
              label: `${dayName} Morning`,
              dateLabel,
              timeRangeLabel: formatArrivalRange(openSlots, timeZone),
              isCurrentBlock,
              openSlotsCount,
              totalSlotsCount,
              utilizationPercentage,
              isHighDemand: utilizationPercentage > 60
            },
            openSlots
          })
        }
      }

      // Afternoon block: 12:30 until closeTime
      if (hours.closeTime > CBTF_AFTERNOON_DIVIDING_TIME) {
        const blockStart = afternoonDividingUtc
        const blockEnd = combineDateAndTime(dateStr, hours.closeTime, timeZone)
        const theoreticalBlockSlots = theoreticalSlots.filter(
          (s) => s.startTime >= afternoonDividingUtc
        )
        const openSlots = allSlots.filter(
          (s) => s.startTime >= afternoonDividingUtc && s.startTime >= now
        )

        if (openSlots.length > 0) {
          const isCurrentBlock = now >= blockStart && now < blockEnd
          const totalSlotsCount = theoreticalBlockSlots.length
          const openSlotsCount = openSlots.length
          const utilizationPercentage =
            totalSlotsCount > 0
              ? Math.max(
                  0,
                  Math.min(
                    100,
                    Math.round(((totalSlotsCount - openSlotsCount) / totalSlotsCount) * 100)
                  )
                )
              : 100

          candidateBlockItems.push({
            block: {
              facilityId: facility.id,
              facilityName: facility.name,
              totalSeats: facility.totalSeats,
              id: `${dateStr}-afternoon`,
              date: dateStr,
              dayOfWeek,
              blockType: 'afternoon',
              label: `${dayName} Afternoon`,
              dateLabel,
              timeRangeLabel: formatArrivalRange(openSlots, timeZone),
              isCurrentBlock,
              openSlotsCount,
              totalSlotsCount,
              utilizationPercentage,
              isHighDemand: utilizationPercentage > 60
            },
            openSlots
          })
        }
      }
    }

    advanceDate()
  }

  // Identify current in-progress block vs future blocks
  const currentBlockItem = candidateBlockItems.find((i) => i.block.isCurrentBlock)
  const futureBlockItems = candidateBlockItems.filter((i) => !i.block.isCurrentBlock)

  // Evaluate initial lookahead blocks: current (if active) + next 4
  const initialLookaheadBlocks = currentBlockItem
    ? [currentBlockItem.block, ...futureBlockItems.slice(0, 4).map((i) => i.block)]
    : futureBlockItems.slice(0, 4).map((i) => i.block)

  // If all evaluated blocks have utilization > 75%, show next 5 blocks instead of 4
  const allAbove75 =
    initialLookaheadBlocks.length > 0 &&
    initialLookaheadBlocks.every((b) => b.utilizationPercentage > 75)

  const futureCount = allAbove75 ? 5 : 4
  const selectedBlockItems = currentBlockItem
    ? [currentBlockItem, ...futureBlockItems.slice(0, futureCount)]
    : futureBlockItems.slice(0, futureCount)

  const blocks: CbtfHalfDayBlock[] = selectedBlockItems.map((i) => i.block)

  // Backwards compatibility: recommendedDays derived from candidate days
  const uniqueDates = Array.from(new Set(blocks.map((b) => b.date)))
  const recommendedDays: CbtfRecommendedDay[] = uniqueDates.map((dateStr) => {
    const dayBlocks = blocks.filter((b) => b.date === dateStr)
    const firstBlock = dayBlocks[0]
    const totalOpenSlots = dayBlocks.reduce((acc, b) => acc + b.openSlotsCount, 0)
    const avgUtilization = Math.round(
      dayBlocks.reduce((acc, b) => acc + b.utilizationPercentage, 0) / dayBlocks.length
    )
    return {
      facilityId: facility.id,
      facilityName: facility.name,
      date: dateStr,
      dayOfWeek: firstBlock.dayOfWeek,
      label: `${firstBlock.label.split(' ')[0]}, ${firstBlock.dateLabel}`,
      openSlotsCount: totalOpenSlots,
      utilizationPercentage: avgUtilization
    }
  })

  // Determine which block to pick hourly slots for
  let chosenBlockItem: (typeof selectedBlockItems)[number] | undefined = selectedBlockItems[0]

  if (preferenceOrBlockId) {
    const blockItems = preloadedReservations ? candidateBlockItems : selectedBlockItems
    const matchById = blockItems.find((i) => i.block.id === preferenceOrBlockId)
    if (matchById) {
      chosenBlockItem = matchById
    } else if (preloadedReservations && /^\d{4}-/.test(preferenceOrBlockId)) {
      chosenBlockItem = undefined
    } else if (selectedDateStr) {
      const matchByDatePref = selectedBlockItems.find(
        (i) =>
          i.block.date === selectedDateStr &&
          (!preferenceOrBlockId || i.block.blockType === preferenceOrBlockId)
      )
      if (matchByDatePref) {
        chosenBlockItem = matchByDatePref
      }
    } else if (preferenceOrBlockId === 'morning' || preferenceOrBlockId === 'afternoon') {
      const matchByPref = selectedBlockItems.find((i) => i.block.blockType === preferenceOrBlockId)
      if (matchByPref) {
        chosenBlockItem = matchByPref
      }
    }
  } else if (selectedDateStr) {
    const matchByDate = selectedBlockItems.find((i) => i.block.date === selectedDateStr)
    if (matchByDate) {
      chosenBlockItem = matchByDate
    }
  }

  let hourlySlots: CbtfHourlySlotChoice[] = []
  if (chosenBlockItem && preloadedReservations) {
    hourlySlots = chosenBlockItem.openSlots.map((slot) => {
      const parts = getLocalTimeParts(slot.startTime, timeZone)
      return {
        facilityId: facility.id,
        facilityName: facility.name,
        hour: parts.hour24,
        startTime: slot.startTime.toISOString(),
        endTime: slot.endTime.toISOString(),
        formattedTime: parts.formattedTime
      }
    })
  } else if (chosenBlockItem) {
    // Group slots by half-hour period (e.g. 09:00, 09:30, 10:00, ...) in facility timezone
    const slotsByHalfHour = new Map<number, SlotAvailability[]>()
    for (const slot of chosenBlockItem.openSlots) {
      const parts = getLocalTimeParts(slot.startTime, timeZone)
      const halfHourBucket = parts.minute < 30 ? 0 : 30
      const periodKey = parts.hour24 * 60 + halfHourBucket

      if (!slotsByHalfHour.has(periodKey)) {
        slotsByHalfHour.set(periodKey, [])
      }
      slotsByHalfHour.get(periodKey)!.push(slot)
    }

    const sortedPeriodKeys = Array.from(slotsByHalfHour.keys()).sort((a, b) => a - b)
    hourlySlots = sortedPeriodKeys.map((periodKey) => {
      const candidates = slotsByHalfHour.get(periodKey)!

      // Maximum available openings priority:
      // Find the minimum arrivalsCount across all candidate slots in this half-hour
      const minArrivals = Math.min(...candidates.map((s) => s.arrivalsCount))
      const minArrivalCandidates = candidates.filter((s) => s.arrivalsCount === minArrivals)

      // Secondary tie-breaker: minimum occupied seats across facility
      const minOccupiedSeats = Math.min(...minArrivalCandidates.map((s) => s.occupiedSeatsCount))
      const bestCandidates = minArrivalCandidates.filter(
        (s) => s.occupiedSeatsCount === minOccupiedSeats
      )

      // Randomly choose among the candidate slots with the same maximum openings
      const randomIndex = Math.floor(Math.random() * bestCandidates.length)
      const chosenSlot = bestCandidates[randomIndex]

      const start = chosenSlot.startTime
      const end = chosenSlot.endTime

      const parts = getLocalTimeParts(start, timeZone)

      return {
        facilityId: facility.id,
        facilityName: facility.name,
        hour: parts.hour24,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        formattedTime: parts.formattedTime
      }
    })
  }

  const hasAvailableStarts =
    blocks.length > 0 || schedulingPeriods.some((period) => schedulingDays[period].length > 0)
  const status: CbtfFacilityAvailabilityStatus = hasAvailableStarts
    ? 'AVAILABLE'
    : hasConflict
      ? 'STUDENT_CONFLICT'
      : futureCapacity.hasFreeSeat
        ? 'ARRIVAL_LIMIT_REACHED'
        : hasFutureStarts
          ? 'NO_AVAILABLE_SEATS'
          : hasOverlappingHours
            ? 'NO_FUTURE_STARTS'
            : 'NO_CONFIGURED_FACILITY_HOURS'

  return {
    status,
    blocks,
    recommendedDays,
    hourlySlots,
    schedulingDays,
    accumulateCapacity
  }
}

/**
 * Projects a raw Prisma CbtfReservation to a CbtfReservationDto
 */
export function toCbtfReservationDto(res: any): CbtfReservationDto {
  return {
    id: res.id,
    facilityId: res.facilityId,
    facilityName: res.facility?.name,
    assignmentId: res.assignmentId,
    assignmentTitle: res.assignment?.title,
    userId: res.userId,
    studentName: res.user ? `${res.user.firstName} ${res.user.lastName}` : undefined,
    studentEmail: res.user?.email ?? null,
    studentId: res.user?.studentId ?? null,
    studentAvatarUrl: res.user?.avatarUrl ?? null,
    seatNumber: res.seatNumber,
    startTime: res.startTime instanceof Date ? res.startTime.toISOString() : res.startTime,
    endTime: res.endTime instanceof Date ? res.endTime.toISOString() : res.endTime,
    status: res.status,
    checkedInAt: res.checkedInAt
      ? res.checkedInAt instanceof Date
        ? res.checkedInAt.toISOString()
        : res.checkedInAt
      : null,
    checkedOutAt: res.checkedOutAt
      ? res.checkedOutAt instanceof Date
        ? res.checkedOutAt.toISOString()
        : res.checkedOutAt
      : null,
    checkedInByUserId: res.checkedInByUserId ?? null,
    checkedOutByUserId: res.checkedOutByUserId ?? null,
    canvasOverrideId: res.canvasOverrideId ?? null,
    noteCount: res.notes ? res.notes.length : undefined,
    notes: res.notes
      ? res.notes.map((n: any) => ({
          id: n.id,
          reservationId: n.reservationId,
          authorId: n.authorId,
          authorName: n.author ? `${n.author.firstName} ${n.author.lastName}`.trim() : undefined,
          content: n.content,
          hasPhotos: Boolean(n.hasPhotos),
          createdAt: n.createdAt instanceof Date ? n.createdAt.toISOString() : n.createdAt,
          updatedAt: n.updatedAt instanceof Date ? n.updatedAt.toISOString() : n.updatedAt
        }))
      : undefined
  }
}

/**
 * Marks reservation DTOs whose seat is currently out of service.
 * Defensive: returns input unchanged if the db client does not expose seat status.
 */
export async function applySeatOutOfServiceFlags<
  T extends { facilityId?: string | null; seatNumber: number; seatOutOfService?: boolean }
>(db: PrismaClient | Prisma.TransactionClient, reservations: T[]): Promise<T[]> {
  if (reservations.length === 0) return reservations
  if (typeof (db as any).cbtfSeatStatus?.findMany !== 'function') return reservations

  const facilityIds = [
    ...new Set(
      reservations
        .map((reservation) => reservation.facilityId)
        .filter((facilityId): facilityId is string => Boolean(facilityId))
    )
  ]
  if (facilityIds.length === 0) return reservations

  const statuses: Array<{ facilityId: string; seatNumber: number }> = await (
    db as any
  ).cbtfSeatStatus.findMany({
    where: { facilityId: { in: facilityIds }, isDisabled: true },
    select: { facilityId: true, seatNumber: true }
  })
  const disabled = new Set(statuses.map((status) => `${status.facilityId}:${status.seatNumber}`))
  for (const reservation of reservations) {
    reservation.seatOutOfService = Boolean(
      reservation.facilityId && disabled.has(`${reservation.facilityId}:${reservation.seatNumber}`)
    )
  }
  return reservations
}

/**
 * Returns live feed of seated roster, arriving students, departures, and facility capacity
 */
export async function getProctorLiveFeed(prisma: PrismaClient, facilityId?: string) {
  if (!facilityId) return null

  const facility = await prisma.cbtfFacility.findUnique({ where: { id: facilityId } })
  if (!facility) return null

  const now = new Date()
  const graceMinutes = facility.checkInGraceMinutes ?? 15

  const reservations = await prisma.cbtfReservation.findMany({
    where: {
      facilityId: facility.id,
      OR: [
        { status: 'CHECKED_IN' },
        {
          status: 'SCHEDULED',
          startTime: {
            gte: new Date(now.getTime() - graceMinutes * 60000),
            lte: new Date(now.getTime() + 90 * 60000)
          }
        },
        {
          status: 'CHECKED_OUT',
          checkedOutAt: {
            gte: new Date(now.getTime() - 30 * 60000)
          }
        }
      ]
    },
    include: {
      assignment: { select: { title: true } },
      facility: { select: { name: true } },
      notes: {
        include: {
          author: { select: { firstName: true, lastName: true } }
        },
        orderBy: { createdAt: 'asc' }
      },
      user: {
        select: {
          firstName: true,
          lastName: true,
          studentId: true,
          avatarUrl: true
        }
      }
    },
    orderBy: { seatNumber: 'asc' }
  })

  // Seated: currently checked in
  const seated = reservations
    .filter((r) => r.status === 'CHECKED_IN')
    .map((r) => {
      const dto = toCbtfReservationDto(r)
      const startMs = new Date(r.startTime).getTime()
      const endMs = new Date(r.endTime).getTime()
      const nowMs = now.getTime()
      const elapsedMinutes = Math.max(0, Math.floor((nowMs - startMs) / 60000))
      const remainingMinutes = Math.max(0, Math.floor((endMs - nowMs) / 60000))
      return {
        ...dto,
        elapsedMinutes,
        remainingMinutes
      }
    })

  // Arriving: SCHEDULED, within upcoming slot window
  const arriving = reservations
    .filter((r) => r.status === 'SCHEDULED')
    .map(toCbtfReservationDto)
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())

  // Pending departures come first, followed by the most recent completed checkouts.
  const pendingDepartures = reservations
    .filter(
      (reservation) =>
        reservation.status === 'CHECKED_IN' &&
        reservation.endTime.getTime() - now.getTime() <= 10 * 60000
    )
    .sort((a, b) => a.endTime.getTime() - b.endTime.getTime() || a.id.localeCompare(b.id))
    .map((reservation) => ({
      ...toCbtfReservationDto(reservation),
      departureStatus: reservation.endTime <= now ? 'OVERDUE' : 'ENDING_SOON'
    }))
  const recentCheckouts = reservations
    .filter((reservation) => reservation.status === 'CHECKED_OUT')
    .sort(
      (a, b) =>
        (b.checkedOutAt?.getTime() ?? 0) - (a.checkedOutAt?.getTime() ?? 0) ||
        a.id.localeCompare(b.id)
    )
    .map((reservation) => ({
      ...toCbtfReservationDto(reservation),
      departureStatus: 'CHECKED_OUT'
    }))
  const departures = [...pendingDepartures, ...recentCheckouts]

  const totalSeats = facility.totalSeats ?? 48
  const seatStatuses = await prisma.cbtfSeatStatus.findMany({
    where: { facilityId: facility.id, isDisabled: true },
    select: { seatNumber: true, isDisabled: true }
  })
  const disabledSeats = getDisabledSeatNumbers(seatStatuses, totalSeats)
  const disabledSeatSet = new Set(disabledSeats)
  for (const reservation of [...seated, ...arriving, ...departures] as Array<{
    seatNumber?: number
    seatOutOfService?: boolean
  }>) {
    if (typeof reservation.seatNumber === 'number') {
      reservation.seatOutOfService = disabledSeatSet.has(reservation.seatNumber)
    }
  }
  const allocatableSeats = new Set(getAllocatableSeatNumbers(facility, disabledSeats))
  const spares = getSpareSeatNumbers(facility, disabledSeats)
  const occupiedSeats = seated.length
  const seatedOnAllocatable = seated.filter((reservation) =>
    allocatableSeats.has(reservation.seatNumber)
  ).length
  const availableSeats = Math.max(0, allocatableSeats.size - seatedOnAllocatable)

  return {
    facility: {
      id: facility.id,
      name: facility.name,
      timezone: facility.timezone,
      totalSeats,
      workingSeats: totalSeats - disabledSeats.length,
      spareSeats: spares.length,
      outOfServiceSeats: disabledSeats.length,
      occupiedSeats,
      availableSeats,
      checkInLeadMinutes: facility.checkInLeadMinutes ?? 5,
      checkInGraceMinutes: facility.checkInGraceMinutes ?? 15
    },
    counts: {
      seated: seated.length,
      arriving: arriving.length,
      departures: departures.length
    },
    seated,
    arriving,
    departures
  }
}

/**
 * Looks up student by studentId and determines check-in / check-out decision
 */
export async function lookupStudentForProctor(prisma: PrismaClient, studentId: string) {
  const cleanId = studentId.trim()
  if (!cleanId) {
    throw createError({ statusCode: 400, statusMessage: 'Student ID is required' })
  }

  const user = await prisma.user.findFirst({
    where: {
      studentId: cleanId
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      studentId: true,
      email: true,
      avatarUrl: true
    }
  })

  if (!user) {
    return {
      found: false,
      student: null,
      reservation: null,
      decision: 'STUDENT_NOT_FOUND',
      message: `No student found matching ID: ${cleanId}`
    }
  }

  const now = new Date()
  const nowMs = now.getTime()
  const reservations = await prisma.cbtfReservation.findMany({
    where: { userId: user.id, status: { in: ['CHECKED_IN', 'SCHEDULED'] } },
    include: {
      assignment: { select: { title: true } },
      facility: { select: { name: true, checkInLeadMinutes: true, checkInGraceMinutes: true } },
      notes: {
        include: { author: { select: { firstName: true, lastName: true } } },
        orderBy: { createdAt: 'asc' }
      }
    },
    orderBy: [{ startTime: 'asc' }, { id: 'asc' }]
  })

  const seated = reservations.filter((reservation) => reservation.status === 'CHECKED_IN').reverse()
  const scheduled = reservations
    .filter((reservation) => reservation.status === 'SCHEDULED')
    .map((reservation) => {
      const startMs = reservation.startTime.getTime()
      const leadMinutes = reservation.facility.checkInLeadMinutes ?? 5
      const graceMinutes = reservation.facility.checkInGraceMinutes ?? 15
      return {
        reservation,
        startMs,
        leadMinutes,
        graceMinutes,
        earliestAllowedMs: startMs - leadMinutes * 60000,
        latestAllowedMs: startMs + graceMinutes * 60000
      }
    })

  // Prefer check-in now, then the next exam, then a late exam that is still in progress.
  const checkInCandidate =
    scheduled.find(
      ({ earliestAllowedMs, latestAllowedMs, reservation }) =>
        nowMs >= earliestAllowedMs && nowMs <= latestAllowedMs && reservation.endTime >= now
    ) ??
    scheduled.find(({ startMs }) => startMs > nowMs) ??
    [...scheduled].reverse().find(({ reservation }) => reservation.endTime >= now)

  // Preserve checkout for overdue occupants when there is no relevant scheduled exam.
  const seatedReservation =
    seated.find((reservation) => reservation.endTime >= now) ??
    (checkInCandidate ? undefined : seated[0])

  if (seatedReservation) {
    return {
      found: true,
      student: user,
      reservation: toCbtfReservationDto({ ...seatedReservation, user }),
      decision: 'READY_FOR_CHECKOUT',
      leadMinutes: seatedReservation.facility.checkInLeadMinutes ?? 5,
      graceMinutes: seatedReservation.facility.checkInGraceMinutes ?? 15,
      message: 'Student is currently seated and ready for checkout.'
    }
  }

  if (checkInCandidate) {
    const {
      reservation: scheduledReservation,
      startMs,
      leadMinutes,
      graceMinutes,
      earliestAllowedMs,
      latestAllowedMs
    } = checkInCandidate
    const dto = toCbtfReservationDto({ ...scheduledReservation, user })

    if (nowMs < earliestAllowedMs) {
      const minutesEarly = Math.ceil((earliestAllowedMs - nowMs) / 60000)
      return {
        found: true,
        student: user,
        reservation: dto,
        decision: 'EARLY',
        leadMinutes,
        graceMinutes,
        message: `Too early to check in. Check-in opens in ${minutesEarly} minute(s) before start time to prevent workstation collision.`
      }
    }

    if (nowMs > latestAllowedMs) {
      const minutesLate = Math.floor((nowMs - startMs) / 60000)
      return {
        found: true,
        student: user,
        reservation: dto,
        decision: 'LATE',
        leadMinutes,
        graceMinutes,
        message: `Reservation is ${minutesLate} minutes late (grace period: ${graceMinutes} mins). Proctor override required to check in.`
      }
    }

    return {
      found: true,
      student: user,
      reservation: dto,
      decision: 'READY_FOR_CHECKIN',
      leadMinutes,
      graceMinutes,
      message: `Verified for ${scheduledReservation.assignment?.title || 'Exam'}. Direct to ${scheduledReservation.facility.name} · Seat #${scheduledReservation.seatNumber}.`
    }
  }

  const pastReservation = await prisma.cbtfReservation.findFirst({
    where: { userId: user.id },
    include: {
      assignment: { select: { title: true } },
      facility: { select: { name: true, checkInLeadMinutes: true, checkInGraceMinutes: true } }
    },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }]
  })

  return {
    found: true,
    student: user,
    reservation: pastReservation ? toCbtfReservationDto({ ...pastReservation, user }) : null,
    decision: 'NO_ACTIVE_RESERVATION',
    leadMinutes: pastReservation?.facility.checkInLeadMinutes,
    graceMinutes: pastReservation?.facility.checkInGraceMinutes,
    message: pastReservation
      ? `No active reservation scheduled for now. Last reservation status: ${pastReservation.status}.`
      : 'No scheduled exam reservations found for this student.'
  }
}

/**
 * Checks in a scheduled reservation
 */
export async function checkInReservation(
  prisma: Prisma.TransactionClient,
  reservationId: string,
  proctorUserId: string,
  verifiedStudentId: string
) {
  const reservation = await prisma.cbtfReservation.findUnique({
    where: { id: reservationId },
    include: {
      assignment: { select: { title: true } },
      user: {
        select: {
          firstName: true,
          lastName: true,
          studentId: true,
          avatarUrl: true
        }
      }
    }
  })

  if (!reservation) {
    throw createError({ statusCode: 404, statusMessage: 'Reservation not found' })
  }

  if (reservation.status === 'CHECKED_IN') {
    throw createError({ statusCode: 400, statusMessage: 'Student is already checked in' })
  }

  if (reservation.status !== 'SCHEDULED') {
    throw createError({
      statusCode: 400,
      statusMessage: `Cannot check in reservation with status '${reservation.status}'`
    })
  }

  if (!verifiedStudentId || reservation.user?.studentId !== verifiedStudentId) {
    throw createError({
      statusCode: 409,
      statusMessage: 'Student ID does not match this reservation'
    })
  }

  const seatStatus = await (prisma as any).cbtfSeatStatus?.findUnique?.({
    where: {
      facilityId_seatNumber: {
        facilityId: reservation.facilityId,
        seatNumber: reservation.seatNumber
      }
    },
    select: { isDisabled: true }
  })
  if (seatStatus?.isDisabled) {
    throw createError({
      statusCode: 409,
      statusMessage:
        'This seat is out of service. Move the student to another seat before checking in.'
    })
  }

  const updated = await prisma.cbtfReservation
    .update({
      where: {
        id: reservationId,
        status: 'SCHEDULED',
        facilityId: reservation.facilityId,
        seatNumber: reservation.seatNumber
      },
      data: {
        status: 'CHECKED_IN',
        checkedInAt: new Date(),
        checkedInByUserId: proctorUserId
      },
      include: {
        assignment: { select: { title: true } },
        facility: { select: { name: true } },
        user: {
          select: {
            firstName: true,
            lastName: true,
            studentId: true,
            avatarUrl: true
          }
        }
      }
    })
    .catch((error) => {
      if (error?.code === 'P2025') {
        throw createError({
          statusCode: 409,
          statusMessage:
            'Reservation status or seat assignment has changed. Please look up the student again.'
        })
      }
      throw error
    })

  return toCbtfReservationDto(updated)
}

/**
 * Checks out a seated reservation
 */
export async function checkOutReservation(
  prisma: PrismaClient,
  reservationId: string,
  proctorUserId: string,
  verifiedStudentId: string
) {
  const reservation = await prisma.cbtfReservation.findUnique({
    where: { id: reservationId },
    include: {
      assignment: { select: { title: true } },
      user: {
        select: {
          firstName: true,
          lastName: true,
          studentId: true,
          avatarUrl: true
        }
      }
    }
  })

  if (!reservation) {
    throw createError({ statusCode: 404, statusMessage: 'Reservation not found' })
  }

  if (reservation.status !== 'CHECKED_IN') {
    throw createError({
      statusCode: 400,
      statusMessage: `Reservation is not currently checked in (status: '${reservation.status}')`
    })
  }

  if (!verifiedStudentId || reservation.user?.studentId !== verifiedStudentId) {
    throw createError({
      statusCode: 409,
      statusMessage: 'Student ID does not match this reservation'
    })
  }

  const updated = await prisma.cbtfReservation
    .update({
      where: {
        id: reservationId,
        status: 'CHECKED_IN'
      },
      data: {
        status: 'CHECKED_OUT',
        checkedOutAt: new Date(),
        checkedOutByUserId: proctorUserId
      },
      include: {
        assignment: { select: { title: true } },
        facility: { select: { name: true } },
        notes: {
          include: {
            author: { select: { firstName: true, lastName: true } }
          },
          orderBy: { createdAt: 'asc' }
        },
        user: {
          select: {
            firstName: true,
            lastName: true,
            studentId: true,
            avatarUrl: true
          }
        }
      }
    })
    .catch((error) => {
      if (error?.code === 'P2025') {
        throw createError({
          statusCode: 409,
          statusMessage: 'Reservation status has changed. Please look up the student again.'
        })
      }
      throw error
    })

  // Trigger incident email notification if any notes exist for this test session
  const noteCount =
    (await (prisma as any).cbtfReservationNote?.count?.({
      where: { reservationId }
    })) ?? 0
  if (noteCount > 0) {
    sendCbtfIncidentNotification(reservationId).catch((err: any) => {
      console.error('[CBTF Notification] Checkout notification dispatch error:', err)
    })
  }

  return toCbtfReservationDto(updated)
}

/**
 * Adds a proctor observation note / incident report to a reservation.
 */
export async function addReservationNote(
  prisma: PrismaClient,
  data: {
    reservationId: string
    authorId: string
    content: string
    hasPhotos?: boolean
  }
) {
  const reservation = await prisma.cbtfReservation.findUnique({
    where: { id: data.reservationId },
    select: { id: true }
  })
  if (!reservation) {
    throw createError({ statusCode: 404, statusMessage: 'Reservation not found' })
  }

  const note = await prisma.cbtfReservationNote.create({
    data: {
      reservationId: reservation.id,
      authorId: data.authorId,
      content: data.content.trim(),
      hasPhotos: Boolean(data.hasPhotos)
    },
    include: {
      author: {
        select: {
          firstName: true,
          lastName: true,
          email: true
        }
      },
      reservation: {
        select: {
          id: true,
          seatNumber: true,
          facility: { select: { name: true } },
          user: {
            select: {
              firstName: true,
              lastName: true,
              studentId: true
            }
          }
        }
      }
    }
  })

  return {
    id: note.id,
    reservationId: note.reservationId,
    seatNumber: note.reservation.seatNumber,
    facilityName: note.reservation.facility.name,
    studentName: `${note.reservation.user.firstName} ${note.reservation.user.lastName}`.trim(),
    authorId: note.authorId,
    authorName: `${note.author.firstName} ${note.author.lastName}`.trim(),
    content: note.content,
    hasPhotos: note.hasPhotos,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString()
  }
}
