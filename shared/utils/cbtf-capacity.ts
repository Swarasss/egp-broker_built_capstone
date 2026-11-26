export function getConfiguredCbtfSeatCount(facilities: readonly { totalSeats: number }[]): number {
  return facilities.reduce((total, facility) => total + facility.totalSeats, 0)
}
