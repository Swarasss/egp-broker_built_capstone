import type { CbtfReservationStatus, Prisma } from '@prisma/client'

export const cbtfRetakePassType = {
  extensionOnly: false,
  extendsCutoffOnly: false
} as const

export const cbtfRetakeClaimSelect = {
  id: true,
  status: true,
  checkedInAt: true,
  checkedOutAt: true
} satisfies Prisma.CbtfReservationSelect

type RetakeClaim = {
  id: string
  status: CbtfReservationStatus
  checkedInAt: Date | null
  checkedOutAt: Date | null
}

type RetakeReceipt = {
  availableFrom: Date | null
  createdAt: Date
  acceptUntil: Date | null
  dueDate: Date | null
  cbtfRetake: RetakeClaim | null
}

export function getOpenCbtfRetakeWindow(
  receipt: RetakeReceipt,
  now: Date,
  reservationId?: string
) {
  const claim = receipt.cbtfRetake
  if (claim) {
    if (claim.checkedInAt || claim.checkedOutAt) return null
    if (reservationId && claim.id !== reservationId) return null

    const reusable = claim.status === 'MISSED' || claim.status === 'CANCELLED'
    const rescheduling = claim.status === 'SCHEDULED' && claim.id === reservationId
    if (!reusable && !rescheduling) return null
  }
  const start = receipt.availableFrom ?? receipt.createdAt
  const end = receipt.acceptUntil ?? receipt.dueDate
  if (!start || !end || !(start < end && start <= now && now < end)) return null
  return { start, end }
}
