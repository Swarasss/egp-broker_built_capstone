import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateAvailableSlotsForDate, getRecommendedDaysAndSlots } from '@@/server/utils/cbtf'

vi.mock('@@/server/utils/db', () => ({ default: {} }))

const day = '2030-01-07'
const facility = {
  id: 'center', name: 'Center', totalSeats: 1, timezone: 'UTC',
  seatAllocationOrder: [1], operatingHours: [], scheduleExceptions: []
} as any
const window = {
  start: new Date(`${day}T09:00:00Z`), end: new Date(`${day}T18:00:00Z`),
  isPassWindow: false, redemptionId: null
}

function database(openTime = '08:02', closeTime = '18:00') {
  return {
    cbtfReservation: { findMany: vi.fn().mockResolvedValue([]) },
    cbtfScheduleException: { findFirst: vi.fn().mockResolvedValue(null) },
    cbtfOperatingHours: { findUnique: vi.fn().mockResolvedValue({ openTime, closeTime }) }
  } as any
}

describe('CBTF aligned arrivals and half-day labels', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    vi.spyOn(Math, 'random').mockReturnValue(0.999)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each(['08:02', '08:05'])('opening at %s starts at 08:05 and keeps every candidate aligned', openTime => {
    const slots = generateAvailableSlotsForDate(facility, new Date(`${day}T00:00:00Z`), {
      isOpen: true, openTime, closeTime: '11:00', reason: null
    }, [], 'UTC', 75)
    expect(slots[0]!.startTime.toISOString()).toBe(`${day}T08:05:00.000Z`)
    for (const slot of slots) {
      expect(slot.startTime.getUTCMinutes() % 5).toBe(0)
      expect(slot.startTime.getUTCSeconds()).toBe(0)
      expect(slot.startTime.getUTCMilliseconds()).toBe(0)
      expect(slot.endTime.getTime() - slot.startTime.getTime()).toBe(75 * 60_000)
      expect(slot.endTime.getTime()).toBeLessThanOrEqual(new Date(`${day}T11:00:00Z`).getTime())
    }
  })

  it('rounds to the next hour when opening at 08:59', () => {
    const slots = generateAvailableSlotsForDate(facility, new Date(`${day}T00:00:00Z`), {
      isOpen: true, openTime: '08:59', closeTime: '11:00', reason: null
    }, [], 'UTC', 75)
    expect(slots[0]!.startTime.toISOString()).toBe(`${day}T09:00:00.000Z`)
  })

  it('labels the actual exam-window-limited morning arrival range', async () => {
    const result = await getRecommendedDaysAndSlots(facility, {
      ...window, end: new Date(`${day}T13:00:00Z`)
    }, 'morning', undefined, database(), 75)
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0]!.timeRangeLabel).toBe('9:00 AM – 11:45 AM')
    expect(result.hourlySlots.at(-1)!.startTime).toBe(`${day}T11:45:00.000Z`)
    expect(result.hourlySlots.at(-1)!.endTime).toBe(`${day}T13:00:00.000Z`)
  })

  it.each([
    ['18:00', '4:45 PM', '16:45'], ['19:00', '5:45 PM', '17:45']
  ])('clips the 75-minute afternoon arrival label for a %s closing', async (close, label, latest) => {
    const result = await getRecommendedDaysAndSlots({ ...facility, totalSeats: 48,
      seatAllocationOrder: Array.from({ length: 48 }, (_, i) => i + 1)
    }, { ...window, start: new Date(`${day}T08:00:00Z`), end: new Date(`${day}T19:00:00Z`) },
    'afternoon', undefined, database('08:00', close), 75)
    expect(result.blocks.map(b => b.timeRangeLabel)).toEqual(['8:00 AM – 12:25 PM', `12:30 PM – ${label}`])
    expect(result.blocks.every(b => b.totalSeats === 48)).toBe(true)
    expect(result.hourlySlots.at(-1)!.startTime).toBe(`${day}T${latest}:00.000Z`)
    expect(result.hourlySlots.at(-1)!.endTime).toBe(`${day}T${close}:00.000Z`)
  })

  it.each(['morning', 'afternoon'])('preserves %s filtering, alignment, and one choice per half-hour', async preference => {
    const result = await getRecommendedDaysAndSlots(facility, window, preference, undefined, database(), 75)
    const buckets = result.hourlySlots.map(slot => {
      const start = new Date(slot.startTime)
      const minuteOfDay = start.getUTCHours() * 60 + start.getUTCMinutes()
      expect(start.getUTCMinutes() % 5).toBe(0)
      expect(preference === 'morning' ? minuteOfDay < 750 : minuteOfDay >= 750).toBe(true)
      expect(new Date(slot.endTime).getTime() - start.getTime()).toBe(75 * 60_000)
      return Math.floor(minuteOfDay / 30)
    })
    expect(buckets.length).toBe(preference === 'morning' ? 7 : 9)
    expect(new Set(buckets).size).toBe(buckets.length)
  })

  it('keeps arrival labels stable when random tie-breaking changes the recommended starts', async () => {
    const first = await getRecommendedDaysAndSlots(facility, window, 'morning', undefined, database(), 75)
    vi.mocked(Math.random).mockReturnValue(0)
    const second = await getRecommendedDaysAndSlots(facility, window, 'morning', undefined, database(), 75)
    expect(first.blocks.map(b => b.timeRangeLabel)).toEqual(second.blocks.map(b => b.timeRangeLabel))
    expect(first.hourlySlots[0]!.startTime).not.toBe(second.hourlySlots[0]!.startTime)
  })

  it('uses capacity-filtered arrivals for both endpoints of the label', async () => {
    const tx = database()
    tx.cbtfReservation.findMany.mockResolvedValue([
      { startTime: new Date(`${day}T09:00:00Z`), endTime: new Date(`${day}T09:15:00Z`), seatNumber: 1 },
      { startTime: new Date(`${day}T11:45:00Z`), endTime: new Date(`${day}T13:00:00Z`), seatNumber: 1 }
    ])
    const result = await getRecommendedDaysAndSlots(facility, {
      ...window, end: new Date(`${day}T13:00:00Z`)
    }, 'morning', undefined, tx, 75)
    expect(result.blocks[0]!.timeRangeLabel).toBe('9:15 AM – 10:30 AM')
  })

  it('formats aligned arrivals in the facility timezone', async () => {
    const result = await getRecommendedDaysAndSlots({ ...facility, timezone: 'America/New_York' }, {
      ...window, start: new Date(`${day}T00:00:00Z`), end: new Date(`${day}T23:00:00Z`)
    }, 'morning', undefined, database('08:02', '10:00'), 75)
    expect(result.blocks[0]!.timeRangeLabel).toBe('8:05 AM – 8:45 AM')
    expect(result.hourlySlots.every(s => new Date(s.startTime).getUTCMinutes() % 5 === 0)).toBe(true)
  })
})
