/**
 * CBTF seat certifications and SSD accommodation constants.
 *
 * Seat properties are admin-managed tags. A student with required properties
 * may only be seated in a seat that carries all of them; a student with no
 * requirements may only use uncertified seats so special seats stay reserved.
 */

export const CBTF_SEAT_PROPERTY_VALUES = [
  'SSD',
  'ADJUSTABLE_DESK',
  'SCREEN_READER'
] as const

export type CbtfSeatProperty = (typeof CBTF_SEAT_PROPERTY_VALUES)[number]

export const CBTF_SEAT_PROPERTY_LABELS: Record<CbtfSeatProperty, string> = {
  SSD: 'SSD-certified station',
  ADJUSTABLE_DESK: 'Adjustable desk',
  SCREEN_READER: 'Screen reader equipped'
}

/** Common extra-time presets offered in the admin UI. */
export const CBTF_TIME_MULTIPLIER_PRESETS = [1, 1.25, 1.5, 2] as const

export const CBTF_MIN_TIME_MULTIPLIER = 1
export const CBTF_MAX_TIME_MULTIPLIER = 3
