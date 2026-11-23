import { describe, expect, it } from 'vitest'
import { calculateMaxArrivalsPerSlot } from '@@/server/utils/cbtf'
import { scoreCbtfPlacements } from '@@/server/utils/cbtf-placement'

const time = (value: string) => new Date(`2030-01-07T${value}:00Z`)
const start = time('10:30')
const end = time('12:00')
const center = (id: string, totalSeats: number, eligibleSeats = [1, 2]) => ({
  id, name: id, totalSeats, eligibleSeats, opensAt: time('08:00'), closesAt: time('18:00')
})
const reservation = (facilityId: string, seatNumber: number, from: string, until: string) => ({
  facilityId, seatNumber, startTime: time(from), endTime: time(until)
})

describe('CBTF placement scoring', () => {
  it.each([
    ['10:30', 0], ['10:25', 25 / 30], ['10:20', 20 / 30], ['10:15', 0.5],
    ['10:10', 10 / 30], ['10:05', 5 / 30], ['10:00', 0], ['09:55', 0]
  ] as const)('scores a preceding reservation ending at %s with cost %s', (until, penalty) => {
    const result = scoreCbtfPlacements([center('a', 48, [1])], [
      reservation('a', 1, '09:00', until)
    ], start, end)
    expect(result?.fragmentation).toBeCloseTo(penalty)
    expect(result?.score).toBeCloseTo(penalty)
  })

  it('prefers a 25-minute gap after the exam over a 5-minute gap before it', () => {
    const result = scoreCbtfPlacements([center('a', 48)], [
      reservation('a', 1, '09:00', '10:25'),
      reservation('a', 2, '12:25', '14:00')
    ], start, end)
    expect(result?.seatNumber).toBe(2)
    expect(result?.fragmentation).toBeCloseTo(5 / 30)
  })

  it('adds the proportional costs of the gaps on both sides', () => {
    const result = scoreCbtfPlacements([center('a', 48, [1])], [
      reservation('a', 1, '09:00', '10:25'),
      reservation('a', 1, '12:20', '14:00')
    ], start, end)
    expect(result?.fragmentation).toBeCloseTo(25 / 30 + 10 / 30)
  })

  it('packs next to existing reservations on both sides before using the seat order', () => {
    const result = scoreCbtfPlacements([center('a', 48)], [
      reservation('a', 1, '09:00', '10:25'),
      reservation('a', 1, '12:25', '14:00'),
      reservation('a', 2, '09:00', '10:30'),
      reservation('a', 2, '12:00', '14:00')
    ], start, end)
    expect(result).toMatchObject({ seatNumber: 2, fragmentation: 0 })
  })

  it('chooses the less occupied facility and keeps seats independent across facilities', () => {
    const result = scoreCbtfPlacements([center('a', 48), center('b', 57)], [
      reservation('a', 1, '10:00', '11:00')
    ], start, end)
    expect(result).toMatchObject({ facility: { id: 'b' }, seatNumber: 1, occupancy: 0 })
  })

  it('counts arrivals independently from physical occupancy in the score', () => {
    const result = scoreCbtfPlacements([center('a', 48), center('b', 48)], [
      reservation('a', 1, '10:30', '12:00'),
      reservation('b', 1, '10:25', '12:00')
    ], start, end)
    expect(result).toMatchObject({ facility: { id: 'b' }, occupancy: 1 / 48, arrivalCongestion: 0 })
    const pressured = scoreCbtfPlacements([center('a', 48)], [
      reservation('a', 1, '10:30', '12:00')
    ], start, end)
    expect(pressured?.score).toBe(1 / 48 + 1 / 4)
  })

  it.each([[48, 4], [57, 5], [24, 2]])('enforces the %i-seat facility limit of %i exact starts', (capacity, limit) => {
    expect(calculateMaxArrivalsPerSlot(capacity)).toBe(limit)
    const facility = center('a', capacity, [capacity])
    const arrivals = Array.from({ length: limit }, (_, i) => reservation('a', i + 1, '10:30', '12:00'))
    expect(scoreCbtfPlacements([facility], arrivals.slice(1), start, end)?.seatNumber).toBe(capacity)
    expect(scoreCbtfPlacements([facility], arrivals, start, end)).toBeUndefined()
  })

  it('rejects seats that overlap any part of the interval, even when never simultaneously occupied', () => {
    const result = scoreCbtfPlacements([center('a', 2)], [
      reservation('a', 1, '10:00', '11:00'),
      reservation('a', 2, '11:30', '13:00')
    ], start, end)
    expect(result).toBeUndefined()
  })
})
