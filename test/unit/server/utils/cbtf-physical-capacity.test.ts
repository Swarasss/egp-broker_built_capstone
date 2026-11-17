import { describe, expect, it, vi } from 'vitest'
import {
  assignNextSeat, calculateMaxArrivalsPerSlot, generateAvailableSlotsForDate,
  getFacilitySeatAllocationOrder
} from '@@/server/utils/cbtf'

vi.mock('@@/server/utils/db', () => ({ default: {} }))
const day = '2030-01-07'
const at = (time: string) => new Date(`${day}T${time}:00Z`)
const examWindow = { start: at('08:00'), end: at('19:00') }
function facility(totalSeats: number, order = Array.from({ length: totalSeats }, (_, i) => i + 1)) {
  return { totalSeats, seatAllocationOrder: order, timezone: 'UTC' }
}
function arrivals(
  center = facility(48), reservations: { startTime: Date; endTime: Date; seatNumber: number }[] = [],
  duration = 75, openTime = '08:00', closeTime = '19:00', window = examWindow
) {
  return generateAvailableSlotsForDate(center, at('00:00'), {
    isOpen: true, openTime, closeTime, reason: null
  }, reservations, 'UTC', duration, window)
}

describe('CBTF physical seat capacity and effective intervals', () => {
  it.each([
    ['19:00', '17:45', '19:00'], ['18:00', '16:45', '18:00']
  ])('closing at %s clips the latest 75-minute start to %s', (close, latest, end) => {
    const slots = arrivals(facility(48), [], 75, '08:00', close)
    expect(slots[0]!.startTime).toEqual(at('08:00'))
    expect(slots.at(-1)!.startTime).toEqual(at(latest))
    expect(slots.at(-1)!.endTime).toEqual(at(end))
    expect(slots.some(s => s.endTime > at(end))).toBe(false)
  })

  it.each(['08:02', '08:05'])('opening at %s starts at 08:05', open => {
    const slots = arrivals(facility(7), [], 37, open)
    expect(slots[0]!.startTime).toEqual(at('08:05'))
    expect(slots.every(s => s.startTime.getUTCMinutes() % 5 === 0)).toBe(true)
    expect(slots[1]!.startTime.getTime() - slots[0]!.startTime.getTime()).toBe(5 * 60_000)
  })

  it('rounds the assignment start upward when it is later than facility opening', () => {
    const slots = arrivals(facility(19), [], 37, '08:00', '19:00', { start: at('09:02'), end: at('11:02') })
    expect(slots[0]!.startTime).toEqual(at('09:05'))
    expect(slots.at(-1)!.startTime).toEqual(at('10:25'))
    expect(slots.at(-1)!.endTime).toEqual(at('11:02'))
  })

  it.each([[48, 4], [13, 2], [7, 1], [60, 5]])('capacity %i has an exact-start limit of %i', (capacity, limit) => {
    expect(calculateMaxArrivalsPerSlot(capacity)).toBe(limit)
    const center = facility(capacity)
    const reservations = Array.from({ length: limit }, (_, i) => ({
      seatNumber: i + 1, startTime: at('08:00'), endTime: at('09:15')
    }))
    const slots = arrivals(center, reservations)
    expect(slots.some(s => s.startTime.getTime() === at('08:00').getTime())).toBe(false)
    expect(slots[0]!.startTime).toEqual(at('08:05'))
    expect(slots[0]!.totalSeats).toBe(capacity)
    expect(slots[0]!.occupiedSeatsCount).toBe(limit)
  })

  it('reports 48 physical seats regardless of how many possible starts exist', () => {
    const slots = arrivals()
    expect(slots).toHaveLength(118)
    expect(slots.every(s => s.totalSeats === 48)).toBe(true)
  })

  it('counts distinct occupied physical seats rather than overlapping reservation records', () => {
    const center = facility(2, [2, 1])
    const reservations = [
      { seatNumber: 1, startTime: at('08:00'), endTime: at('08:30') },
      { seatNumber: 1, startTime: at('08:30'), endTime: at('09:15') }
    ]
    const candidate = arrivals(center, reservations).find(s => s.startTime.getTime() === at('08:05').getTime())!
    expect(candidate).toBeDefined()
    expect(candidate.occupiedSeatsCount).toBe(1)
    expect(assignNextSeat(getFacilitySeatAllocationOrder(center), candidate.startTime, candidate.endTime, reservations)).toBe(2)
  })

  it('requires one seat free for the entire interval, even when seats are free at different times', () => {
    const reservations = [
      { seatNumber: 1, startTime: at('08:00'), endTime: at('08:30') },
      { seatNumber: 2, startTime: at('08:30'), endTime: at('09:15') }
    ]
    expect(arrivals(facility(2), reservations).some(s => s.startTime.getTime() === at('08:05').getTime())).toBe(false)
  })

  it('does not offer an interval when every configured eligible seat is occupied', () => {
    const center = facility(6, [4, 2])
    const reservations = [
      { seatNumber: 4, startTime: at('08:00'), endTime: at('09:15') },
      { seatNumber: 2, startTime: at('08:05'), endTime: at('09:20') }
    ]
    const slots = arrivals(center, reservations)
    expect(slots[0]!.startTime).toEqual(at('09:15'))
    expect(slots.some(s => s.startTime >= at('08:10') && s.startTime < at('09:15'))).toBe(false)
  })

  it('releases seats exactly at their end, while staggered 75-minute reservations remain occupied', () => {
    const reservations = [
      { seatNumber: 1, startTime: at('08:00'), endTime: at('09:15') },
      { seatNumber: 2, startTime: at('08:05'), endTime: at('09:20') }
    ]
    const slots = arrivals(facility(2), reservations)
    const released = slots.find(s => s.startTime.getTime() === at('09:15').getTime())!
    expect(released).toBeDefined()
    expect(released.occupiedSeatsCount).toBe(1)
    expect(assignNextSeat([2, 1], released.startTime, released.endTime, [reservations[1]!])).toBe(1)
  })
})
