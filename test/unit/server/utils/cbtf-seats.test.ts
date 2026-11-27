import { describe, expect, it, vi } from 'vitest'
import {
  computeSpareSeatNumbers,
  getAllocatableSeatNumbers,
  getDisabledSeatNumbers,
  getRecommendedSpareSeatCount,
  getSeatCapacityCounts,
  getSpareSeatCount,
  getSpareSeatNumbers
} from '@@/shared/utils/cbtf-seats'
import { scoreCbtfPlacements } from '@@/server/utils/cbtf-placement'

vi.mock('@@/server/utils/db', () => ({ default: {} }))

function facility(
  totalSeats: number,
  extra: Partial<{ spareSeatCount: number | null; spareSeatNumbers: number[] }> = {}
) {
  return {
    totalSeats,
    seatAllocationOrder: Array.from({ length: totalSeats }, (_, index) => index + 1),
    ...extra
  }
}

describe('CBTF spare seat capacity', () => {
  it.each([
    [20, 2],
    [48, 5],
    [10, 1],
    [1, 1],
    [0, 0]
  ])('recommends about 10 percent for %i seats (%i spare)', (total, spare) => {
    expect(getRecommendedSpareSeatCount(total)).toBe(spare)
  })

  it('only reserves spares when configured (opt-in)', () => {
    expect(getSpareSeatCount(facility(20))).toBe(0)
    expect(getSpareSeatCount(facility(20, { spareSeatCount: 3 }))).toBe(3)
    expect(getSpareSeatCount(facility(20, { spareSeatCount: 0 }))).toBe(0)
  })

  it('derives spare seats from the tail of the allocation order', () => {
    expect(computeSpareSeatNumbers(facility(20))).toEqual([])
    expect(computeSpareSeatNumbers(facility(20, { spareSeatCount: 2 }))).toEqual([19, 20])
    expect(computeSpareSeatNumbers(facility(10, { spareSeatCount: 1 }))).toEqual([10])
  })

  it('leaves capacity untouched when spares are unset', () => {
    expect(getAllocatableSeatNumbers(facility(20))).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1)
    )
  })

  it('excludes configured spare seats from scheduling', () => {
    expect(getAllocatableSeatNumbers(facility(20, { spareSeatCount: 2 }))).toEqual(
      Array.from({ length: 18 }, (_, index) => index + 1)
    )
  })

  it('excludes out-of-service seats from scheduling', () => {
    expect(getAllocatableSeatNumbers(facility(20, { spareSeatCount: 2 }), [1, 2])).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 3)
    )
  })

  it('removes out-of-service seats from the spare pool', () => {
    expect(getSpareSeatNumbers(facility(20, { spareSeatCount: 2 }), [20])).toEqual([19])
  })

  it('reads disabled seats from status rows (ignoring enabled rows)', () => {
    expect(
      getDisabledSeatNumbers(
        [
          { seatNumber: 3, isDisabled: true },
          { seatNumber: 4, isDisabled: false }
        ],
        10
      )
    ).toEqual([3])
  })

  it('reports capacity counts and available spares', () => {
    expect(getSeatCapacityCounts(facility(20, { spareSeatCount: 2 }), [5], [19])).toMatchObject({
      total: 20,
      working: 19,
      available: 17,
      spare: 2,
      spareAvailable: 1,
      outOfService: 1
    })
  })

  it('keeps spare seats independent per facility', () => {
    expect(getAllocatableSeatNumbers(facility(20, { spareSeatCount: 2 })).at(-1)).toBe(18)
    expect(getAllocatableSeatNumbers(facility(10, { spareSeatCount: 1 })).at(-1)).toBe(9)
  })

  it('uses stored spare seat numbers when provided', () => {
    expect(getSpareSeatNumbers(facility(20, { spareSeatNumbers: [2, 4] }))).toEqual([2, 4])
  })

  it('ignores out-of-range and duplicate stored spare values', () => {
    expect(getSpareSeatNumbers(facility(10, { spareSeatNumbers: [2, 2, 99, 0] }))).toEqual([2])
  })
})

describe('CBTF placement capacity with spares', () => {
  const at = (time: string) => new Date(`2030-01-07T${time}:00Z`)
  const start = at('10:30')
  const end = at('12:00')
  const center = (arrivalCapacity?: number) => ({
    id: 'a',
    name: 'a',
    totalSeats: 48,
    eligibleSeats: [1, 2],
    arrivalCapacity,
    opensAt: at('08:00'),
    closesAt: at('18:00')
  })
  const reservation = (seatNumber: number) => ({
    facilityId: 'a',
    seatNumber,
    startTime: at('10:30'),
    endTime: at('12:00')
  })

  it('throttles on allocatable capacity, not total seats', () => {
    // 12 allocatable seats => ceil(12 / 12) = 1 exact arrival allowed.
    expect(scoreCbtfPlacements([center(12)], [reservation(1)], start, end)).toBeUndefined()
    expect(scoreCbtfPlacements([center(12)], [], start, end)?.seatNumber).toBe(1)
  })

  it('picks the remaining eligible seat when one is occupied', () => {
    expect(scoreCbtfPlacements([center(48)], [reservation(1)], start, end)?.seatNumber).toBe(2)
  })
})
