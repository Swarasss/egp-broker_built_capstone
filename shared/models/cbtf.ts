/**
 * CBTF (Computer-Based Testing Facility) Models
 *
 * Types, interfaces, and DTOs for the CBTF Scheduler feature
 */

import type {
  CbtfFacility,
  CbtfOperatingHours,
  CbtfScheduleException,
  CbtfProctorShift,
  CbtfReservation,
  CbtfReservationStatus,
  CbtfReservationNote,
  CbtfSeatStatus
} from '@prisma/client'

export type {
  CbtfFacility,
  CbtfOperatingHours,
  CbtfScheduleException,
  CbtfProctorShift,
  CbtfReservation,
  CbtfReservationStatus,
  CbtfReservationNote,
  CbtfSeatStatus
}

export interface CbtfFacilitySummary {
  id: string
  name: string
  totalSeats: number
  seatAllocationOrder: number[]
  checkInLeadMinutes?: number
  checkInGraceMinutes?: number
  timezone?: string
  spareSeatCount?: number | null
  spareSeatNumbers?: number[]
  reassignThresholdMinutes?: number
  createdAt: string
  updatedAt: string
}

export interface CbtfOperatingHoursDto {
  id: string
  facilityId: string
  dayOfWeek: number
  openTime: string
  closeTime: string
}

export interface CbtfScheduleExceptionDto {
  id: string
  facilityId: string
  date: string
  isClosed: boolean
  openTime: string | null
  closeTime: string | null
  reason: string | null
}

export interface CbtfProctorShiftDto {
  id: string
  facilityId: string
  userId: string
  userName?: string
  date: string
  startTime: string
  endTime: string
}

export interface CbtfReservationDto {
  id: string
  facilityId: string
  facilityName?: string
  assignmentId: string
  assignmentTitle?: string
  userId: string
  studentName?: string
  studentEmail?: string | null
  studentId?: string | null
  studentAvatarUrl?: string | null
  seatNumber: number
  /** True when this reservation's seat is currently out of service (needs staff attention). */
  seatOutOfService?: boolean
  startTime: string
  endTime: string
  status: CbtfReservationStatus
  checkedInAt: string | null
  checkedOutAt: string | null
  checkedInByUserId: string | null
  checkedOutByUserId: string | null
  canvasOverrideId?: string | null
  noteCount?: number
  notes?: CbtfReservationNoteDto[]
}

export interface CbtfReservationNoteDto {
  id: string
  reservationId: string
  authorId: string
  authorName?: string
  content: string
  hasPhotos: boolean
  createdAt: string
  updatedAt: string
}

export interface CbtfRecommendedDay {
  facilityId: string
  facilityName: string
  date: string // YYYY-MM-DD
  dayOfWeek: number
  label: string // e.g. "Monday, Sep 8"
  openSlotsCount: number
  utilizationPercentage: number
}

export interface CbtfHalfDayBlock {
  totalSeats: number // Persisted physical capacity, never a count of candidate starts.
  facilityId: string
  facilityName: string
  id: string // e.g. "2026-09-15-morning"
  date: string // YYYY-MM-DD
  dayOfWeek: number
  blockType: 'morning' | 'afternoon'
  label: string // e.g. "Tuesday Morning"
  dateLabel: string // e.g. "Sep 15"
  timeRangeLabel: string // e.g. "8:00 AM – 1:00 PM"
  isCurrentBlock: boolean
  openSlotsCount: number // Candidate start timestamps; internal recommendation metadata.
  totalSlotsCount: number // Candidate start timestamps, not physical seats.
  utilizationPercentage: number // Unavailable-arrival percentage; not room occupancy.
  isHighDemand: boolean // true if utilizationPercentage > 60
}

export interface CbtfHourlySlotChoice {
  facilityId: string
  facilityName: string
  hour: number // e.g. 9 for 09:00
  startTime: string // ISO string
  endTime: string // ISO string
  formattedTime: string // e.g. "9:15 AM"
}

export interface CbtfStudentBlock {
  id: string
  label: string
  dateLabel: string
  timezone: string
  isCurrentBlock: boolean
}

export type CbtfStudentStart = Pick<CbtfHourlySlotChoice, 'startTime' | 'endTime' | 'formattedTime'>

/** Certified properties for one physical seat. Empty properties = ordinary seat. */
export interface CbtfSeatDto {
  seatNumber: number
  properties: string[]
}

export interface CbtfSeatMapResponse {
  facilityId: string
  facilityName: string
  totalSeats: number
  seats: CbtfSeatDto[]
}

/** Service state of a physical workstation as shown to staff. */
export type CbtfSeatState = 'IN_SERVICE' | 'OUT_OF_SERVICE' | 'SPARE'

/** The reservation currently using a seat, if any. */
export interface CbtfSeatOccupancyDto {
  reservationId: string
  studentName: string
  assignmentTitle: string
  startTime: string
  endTime: string
  status: CbtfReservationStatus
}

export interface CbtfSeatStatusDto {
  seatNumber: number
  state: CbtfSeatState
  reason: string | null
  disabledAt: string | null
  /** Seat certifications such as SSD, ADJUSTABLE_DESK, SCREEN_READER. */
  properties: string[]
  /** True when a reservation is using this seat right now. */
  occupied: boolean
  /** Details of the current reservation, if any. */
  currentReservation: CbtfSeatOccupancyDto | null
}

export interface CbtfWorkstationCounts {
  total: number
  working: number
  available: number
  spare: number
  spareAvailable: number
  outOfService: number
}

export interface CbtfWorkstationSummary {
  facilityId: string
  facilityName: string
  totalSeats: number
  spareSeatCount: number
  spareSeatNumbers: number[]
  reassignThresholdMinutes: number
  counts: CbtfWorkstationCounts
  seats: CbtfSeatStatusDto[]
  atRisk: CbtfAtRiskReservationDto[]
}

/** A reservation sitting on an out-of-service seat that needs staff attention. */
export interface CbtfAtRiskReservationDto {
  reservationId: string
  seatNumber: number
  userId: string
  studentName: string
  assignmentTitle: string
  startTime: string
  endTime: string
  status: CbtfReservationStatus
}

/** Effective SSD accommodation for a student. */
export interface CbtfAccommodationDto {
  userId: string
  studentName: string
  studentEmail: string
  studentId: string | null
  requiredSeatProperties: string[]
  timeMultiplier: number
  isActive: boolean
  notes: string | null
  updatedAt: string
}

export type CbtfReservationWindowStatus = 'OPEN' | 'NOT_YET_OPEN' | 'CLOSED'

export interface CbtfReservationWindow {
  reservationWindowStatus: CbtfReservationWindowStatus
  reservationWindow: { start: string | null; end: string | null }
}

export type CbtfFacilityAvailabilityStatus =
  | 'AVAILABLE'
  | 'NO_CONFIGURED_FACILITY_HOURS'
  | 'NO_FUTURE_STARTS'
  | 'NO_AVAILABLE_SEATS'
  | 'ARRIVAL_LIMIT_REACHED'
  | 'STUDENT_CONFLICT'

export interface CbtfFacilityAvailabilityDiagnostic {
  facilityId: string
  facilityName: string
  status: CbtfFacilityAvailabilityStatus
}

export type CbtfAvailabilityStatus =
  | CbtfFacilityAvailabilityStatus
  | 'INVALID_ASSIGNMENT_WINDOW'
  | 'RESERVATION_NOT_OPEN'
  | 'RESERVATION_CLOSED'
