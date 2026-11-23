import { describe, it, expect } from 'vitest'
import { createAssignmentSchema, updateAssignmentSchema } from '@@/shared/models/assignment'
import { getAssignmentSchedulingErrors } from '@@/shared/utils/assignment-scheduling'

const valid = {
  courseId: 'course', isSchedulable: true, cbtfDurationMinutes: 90,
  availableFrom: '2030-01-07T09:00:00Z', acceptUntil: '2030-01-07T10:30:00Z',
  scheduleWindowStart: '2030-01-01T00:00:00Z', scheduleWindowEnd: '2030-01-05T00:00:00Z'
}

describe('CBTF instructor window configuration', () => {
  it('allows reservations before the exam date, and an exam window exactly one duration long', () => {
    expect(createAssignmentSchema.safeParse(valid).success).toBe(true)
  })

  it.each([
    { availableFrom: '2030-01-07T11:00:00Z' },
    { acceptUntil: valid.availableFrom },
    { scheduleWindowEnd: valid.scheduleWindowStart },
    { scheduleWindowStart: '2030-01-06T00:00:00Z' },
    { cbtfDurationMinutes: null }, { cbtfDurationMinutes: undefined }, { cbtfDurationMinutes: 0 }, { cbtfDurationMinutes: -1 },
    { acceptUntil: '2030-01-07T10:25:00Z' },
    { availableFrom: 'invalid' }, { availableFrom: null }, { scheduleWindowEnd: null }
  ])('rejects invalid complete configuration %j', change => {
    expect(createAssignmentSchema.safeParse({ ...valid, ...change }).success).toBe(false)
    // Partial schemas validate supplied pairs; API validation checks the complete merged state.
    expect(getAssignmentSchedulingErrors({ ...valid, ...change }).length).toBeGreaterThan(0)
  })

  it('validates pairs in partial updates and keeps single-field updates possible', () => {
    expect(updateAssignmentSchema.safeParse({ availableFrom: valid.acceptUntil, acceptUntil: valid.availableFrom }).success).toBe(false)
    expect(updateAssignmentSchema.safeParse({ cbtfDurationMinutes: 90 }).success).toBe(true)
  })
})
