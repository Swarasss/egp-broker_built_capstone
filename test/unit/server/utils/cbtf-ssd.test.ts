import { describe, it, expect } from 'vitest'
import {
  getEffectiveExamDurationMinutes,
  isSeatEligibleForStudent,
  getEligibleSeatNumbers,
  normalizeSeatProperties,
  generateAvailableSlotsForDate,
  assignNextSeat
} from '../../../../server/utils/cbtf'

describe('CBTF SSD accommodations', () => {
  describe('getEffectiveExamDurationMinutes', () => {
    it('leaves standard time unchanged', () => {
      expect(getEffectiveExamDurationMinutes(60, 1)).toBe(60)
      expect(getEffectiveExamDurationMinutes(20, 1)).toBe(20)
    })

    it('applies the extra-time multiplier', () => {
      expect(getEffectiveExamDurationMinutes(60, 1.5)).toBe(90)
      expect(getEffectiveExamDurationMinutes(120, 2)).toBe(240)
      expect(getEffectiveExamDurationMinutes(60, 1.25)).toBe(75)
    })

    it('rounds up to the next 5-minute boundary', () => {
      expect(getEffectiveExamDurationMinutes(25, 1.5)).toBe(40)
      expect(getEffectiveExamDurationMinutes(45, 1.25)).toBe(60)
    })

    it('falls back to a 60-minute standard duration for invalid input', () => {
      expect(getEffectiveExamDurationMinutes(undefined, undefined)).toBe(60)
      expect(getEffectiveExamDurationMinutes(0, 1.5)).toBe(90)
      expect(getEffectiveExamDurationMinutes(-30, 1.5)).toBe(90)
      expect(getEffectiveExamDurationMinutes(60, 0.5)).toBe(60)
    })
  })

  describe('normalizeSeatProperties', () => {
    it('trims, uppercases, and dedupes tags', () => {
      expect(normalizeSeatProperties([' ssd ', 'SSD', 'Adjustable_Desk', ''])).toEqual([
        'SSD',
        'ADJUSTABLE_DESK'
      ])
    })

    it('returns an empty array for missing properties', () => {
      expect(normalizeSeatProperties(null)).toEqual([])
      expect(normalizeSeatProperties(undefined)).toEqual([])
    })
  })

  describe('isSeatEligibleForStudent', () => {
    it('lets students without requirements use only uncertified seats', () => {
      expect(isSeatEligibleForStudent([], [])).toBe(true)
      expect(isSeatEligibleForStudent(['SSD'], [])).toBe(false)
      expect(isSeatEligibleForStudent(['ADJUSTABLE_DESK'], null)).toBe(false)
    })

    it('requires every accommodation property on the seat', () => {
      expect(isSeatEligibleForStudent(['SSD'], ['SSD'])).toBe(true)
      expect(isSeatEligibleForStudent(['SSD', 'ADJUSTABLE_DESK'], ['SSD'])).toBe(true)
      expect(isSeatEligibleForStudent(['SSD'], ['SSD', 'ADJUSTABLE_DESK'])).toBe(false)
      expect(isSeatEligibleForStudent([], ['SSD'])).toBe(false)
    })

    it('compares properties case-insensitively', () => {
      expect(isSeatEligibleForStudent(['ssd'], ['SSD'])).toBe(true)
    })
  })

  describe('getEligibleSeatNumbers', () => {
    const seatOrder = [1, 2, 3, 4, 5, 6]
    const seatProperties = new Map<number, string[]>([
      [2, ['SSD']],
      [5, ['SSD', 'ADJUSTABLE_DESK']]
    ])

    it('keeps allocation order for students without requirements', () => {
      expect(getEligibleSeatNumbers(seatOrder, seatProperties, [])).toEqual([1, 3, 4, 6])
    })

    it('returns only seats satisfying an accommodation, in order', () => {
      expect(getEligibleSeatNumbers(seatOrder, seatProperties, ['SSD'])).toEqual([2, 5])
      expect(getEligibleSeatNumbers(seatOrder, seatProperties, ['SSD', 'ADJUSTABLE_DESK'])).toEqual([
        5
      ])
    })

    it('accepts a plain record of seat properties', () => {
      expect(getEligibleSeatNumbers(seatOrder, { 3: ['SSD'] }, ['SSD'])).toEqual([3])
    })
  })

  describe('generateAvailableSlotsForDate with eligible seats', () => {
    const facility = { totalSeats: 48, timezone: 'America/New_York' }
    const targetDate = new Date('2026-09-14T00:00:00.000Z')
    const hours = { isOpen: true, openTime: '08:00', closeTime: '09:00', reason: null }

    it('hides slots when every eligible seat is occupied', () => {
      // Plain student is limited to seat 1 (seat 2 is SSD-certified).
      const existingReservations = [
        { startTime: new Date('2026-09-14T12:00:00.000Z'), endTime: new Date('2026-09-14T13:00:00.000Z'), seatNumber: 1 }
      ]
      const slots = generateAvailableSlotsForDate(
        facility,
        targetDate,
        hours,
        existingReservations,
        'America/New_York',
        60,
        undefined,
        [1]
      )
      expect(slots).toHaveLength(0)
    })

    it('offers slots to an accommodated student whose seats are free', () => {
      const existingReservations = [
        { startTime: new Date('2026-09-14T12:00:00.000Z'), endTime: new Date('2026-09-14T13:00:00.000Z'), seatNumber: 1 }
      ]
      const slots = generateAvailableSlotsForDate(
        facility,
        targetDate,
        hours,
        existingReservations,
        'America/New_York',
        60,
        undefined,
        [2]
      )
      expect(slots.length).toBe(1)
      expect(slots[0]!.startTime.toISOString()).toBe('2026-09-14T12:00:00.000Z')
    })

    it('returns no slots when the student has no eligible seats', () => {
      const slots = generateAvailableSlotsForDate(
        facility,
        targetDate,
        hours,
        [],
        'America/New_York',
        60,
        undefined,
        []
      )
      expect(slots).toHaveLength(0)
    })
  })

  describe('assignNextSeat with eligible seats', () => {
    const seatOrder = [1, 2, 3, 4, 5, 6]
    const slotStart = new Date('2026-09-14T09:00:00.000Z')
    const slotEnd = new Date('2026-09-14T10:00:00.000Z')

    it('only allocates seats that meet the accommodation', () => {
      const seat = assignNextSeat(seatOrder, slotStart, slotEnd, [], undefined, [2, 5])
      expect(seat).toBe(2)
    })

    it('skips occupied eligible seats and overflows within the eligible set', () => {
      const seat = assignNextSeat(seatOrder, slotStart, slotEnd, [{ seatNumber: 2 }], undefined, [
        2, 5
      ])
      expect(seat).toBe(5)
    })

    it('throws 409 when every eligible seat is occupied', () => {
      expect(() =>
        assignNextSeat(seatOrder, slotStart, slotEnd, [{ seatNumber: 2 }, { seatNumber: 5 }], undefined, [2, 5])
      ).toThrow('No unallocated seats available at this time slot')
    })

    it('throws 409 when the student has no eligible seats', () => {
      expect(() => assignNextSeat(seatOrder, slotStart, slotEnd, [], undefined, [])).toThrow(
        "No seats are available that meet this student's accommodations"
      )
    })
  })
})
