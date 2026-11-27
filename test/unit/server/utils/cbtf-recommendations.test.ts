import { describe, expect, it } from 'vitest'
import {
  scoreRecommendedStart,
  selectRecommendedStarts
} from '@@/server/utils/cbtf-recommendations'

const minute = 60_000
const start = Date.parse('2030-01-07T13:00:00Z')
const open = { eligibleSeatCount: 8, freeEligibleSeatCount: 8 }
const constrained = { eligibleSeatCount: 8, freeEligibleSeatCount: 1 }

function candidate(minutes: number) {
  const startTime = new Date(start + minutes * minute)
  return {
    startTime,
    endTime: new Date(+startTime + 60 * minute),
    hour: startTime.getUTCHours(),
    timezone: 'UTC'
  }
}

describe('CBTF time recommendations', () => {
  const score = (arrivals: [number, number][], capacity = [open]) =>
    scoreRecommendedStart(start, new Map(arrivals), capacity, 'student-a', 'assignment')

  it('penalizes exact and nearby starts, weighting five minutes more than ten', () => {
    const empty = score([])
    expect(score([[start, 3]]) - empty).toBeCloseTo(9)
    expect(
      score([
        [start - 5 * minute, 1],
        [start + 5 * minute, 1]
      ]) - empty
    ).toBeCloseTo(4)
    expect(
      score([
        [start - 10 * minute, 1],
        [start + 10 * minute, 1]
      ]) - empty
    ).toBeCloseTo(2)
  })

  it('prefers spare eligible capacity and additional feasible facilities', () => {
    expect(score([], [open, open])).toBeLessThan(score([], [open]))
    expect(score([], [open])).toBeLessThan(score([], [constrained]))
    expect(score([], [open, constrained])).toBeLessThan(score([], [constrained, constrained]))
  })

  it('chooses the best validated start per hour with deterministic, student-specific spread', () => {
    const candidates = [10, 15, 20, 25, 60, 65].map(candidate)
    const capacity = new Map(candidates.map(({ startTime }) => [+startTime, [open]]))
    const select = (student: string, assignment: string, loads = new Map<number, number>()) =>
      selectRecommendedStarts(candidates, loads, capacity, student, assignment)

    const first = select('student-a', 'assignment')
    expect(select('student-a', 'assignment')).toEqual(first)
    expect(first.map(({ hour }) => hour)).toEqual([13, 14])
    expect(first.every((slot) => candidates.includes(slot))).toBe(true)
    const students = Array.from({ length: 12 }, (_, index) =>
      select(`student-${index}`, 'assignment')
    )
    expect(new Set(students.map((choices) => +choices[0]!.startTime)).size).toBeGreaterThan(1)
    const loads = new Map([
      [start + 15 * minute, 4],
      [start + 20 * minute, 4],
      [start + 25 * minute, 4]
    ])
    expect(select('student-a', 'assignment', loads)[0]).toEqual(candidates[0])
  })

  it('ranks hourly winners by score before applying the cap and displays them chronologically', () => {
    const candidates = Array.from({ length: 7 }, (_, index) => candidate(index * 60))
    const capacity = new Map(candidates.map(({ startTime }) => [+startTime, [open]]))
    const selected = selectRecommendedStarts(
      candidates,
      new Map([[start, 3]]),
      capacity,
      'student',
      'assignment'
    )
    expect(selected).toEqual(candidates.slice(1))
  })
})
