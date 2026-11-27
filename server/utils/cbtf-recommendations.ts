import { createHash } from 'node:crypto'

const START_LOAD_WEIGHT = 3
const NEARBY_LOAD_WEIGHT = 1
const FACILITY_CONGESTION_WEIGHT = 2
const MAX_STUDENT_VARIATION = 0.001
const FIVE_MINUTES_MS = 5 * 60_000
export const RECOMMENDATION_LOAD_WINDOW_MS = 2 * FIVE_MINUTES_MS
const MAX_RECOMMENDED_STARTS = 6

export interface RecommendationSeatCapacity {
  eligibleSeatCount: number
  freeEligibleSeatCount: number
}

export interface RecommendationCandidate {
  startTime: Date
  endTime: Date
  timezone: string
  hour: number
}

export function scoreRecommendedStart(
  timestamp: number,
  arrivals: ReadonlyMap<number, number>,
  feasibleCapacity: readonly RecommendationSeatCapacity[],
  studentId: string,
  assignmentId: string
): number {
  const startLoad = arrivals.get(timestamp) ?? 0
  const nearbyLoad =
    2 *
      ((arrivals.get(timestamp - FIVE_MINUTES_MS) ?? 0) +
        (arrivals.get(timestamp + FIVE_MINUTES_MS) ?? 0)) +
    (arrivals.get(timestamp - RECOMMENDATION_LOAD_WINDOW_MS) ?? 0) +
    (arrivals.get(timestamp + RECOMMENDATION_LOAD_WINDOW_MS) ?? 0)

  // Discount each facility's free eligible seats by its free fraction.
  // Summing gives credit for both spare capacity and additional feasible facilities.
  const spareCapacity = feasibleCapacity.reduce(
    (sum, { freeEligibleSeatCount, eligibleSeatCount }) =>
      sum + freeEligibleSeatCount ** 2 / eligibleSeatCount,
    0
  )
  const facilityCongestion = 1 / (1 + spareCapacity)
  const hash = createHash('sha256')
    .update(JSON.stringify([studentId, assignmentId, timestamp]))
    .digest()
    .readUInt32BE()
  const epsilon = MAX_STUDENT_VARIATION * (hash / 2 ** 32)
  return (
    START_LOAD_WEIGHT * startLoad +
    NEARBY_LOAD_WEIGHT * nearbyLoad +
    FACILITY_CONGESTION_WEIGHT * facilityCongestion +
    epsilon
  )
}

export function selectRecommendedStarts(
  candidates: readonly RecommendationCandidate[],
  arrivals: ReadonlyMap<number, number>,
  capacity: ReadonlyMap<number, readonly RecommendationSeatCapacity[]>,
  studentId: string,
  assignmentId: string
): RecommendationCandidate[] {
  const scores = new Map<number, number>()
  const ranked = candidates
    .map((candidate) => {
      const timestamp = +candidate.startTime
      let score = scores.get(timestamp)
      if (score === undefined) {
        score = scoreRecommendedStart(
          timestamp,
          arrivals,
          capacity.get(timestamp) ?? [],
          studentId,
          assignmentId
        )
        scores.set(timestamp, score)
      }
      return { candidate, timestamp, score }
    })
    .sort(
      (a, b) =>
        a.score - b.score ||
        a.timestamp - b.timestamp ||
        a.candidate.hour - b.candidate.hour ||
        a.candidate.timezone.localeCompare(b.candidate.timezone)
    )

  // A timestamp may appear under different local hours at different facilities.
  const usedHours = new Set<number>()
  const usedStarts = new Set<number>()
  const selected: RecommendationCandidate[] = []
  for (const { candidate, timestamp } of ranked) {
    if (usedHours.has(candidate.hour) || usedStarts.has(timestamp)) continue
    usedHours.add(candidate.hour)
    usedStarts.add(timestamp)
    selected.push(candidate)
    if (selected.length === MAX_RECOMMENDED_STARTS) break
  }
  return selected.sort((a, b) => +a.startTime - +b.startTime)
}
