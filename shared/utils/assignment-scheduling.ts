/** Shared instructor validation; accepts local form dates, API strings, or database dates. */
export interface AssignmentSchedulingConfig {
  isSchedulable?: boolean | null
  availableFrom?: string | Date | null
  acceptUntil?: string | Date | null
  scheduleWindowStart?: string | Date | null
  scheduleWindowEnd?: string | Date | null
  cbtfDurationMinutes?: number | null
}

export function getAssignmentSchedulingErrors(
  config: AssignmentSchedulingConfig,
  requireComplete = true
): { name: string; message: string }[] {
  const errors: { name: string; message: string }[] = []
  const required = requireComplete && config.isSchedulable
  const pairs = [
    ['availableFrom', 'acceptUntil', 'Available From', 'Accept Until'],
    ['scheduleWindowStart', 'scheduleWindowEnd', 'Reservation Window Start', 'Reservation Window End']
  ] as const
  for (const [startKey, endKey, startLabel, endLabel] of pairs) {
    const start = config[startKey]
    const end = config[endKey]
    for (const [name, value, label] of [[startKey, start, startLabel], [endKey, end, endLabel]] as const) {
      if (!value && required) errors.push({ name, message: `${label} is required for CBTF scheduling.` })
      else if (value && !Number.isFinite(new Date(value).getTime())) {
        errors.push({ name, message: `${label} must be a valid date and time.` })
      }
    }
    if (start && end && new Date(start).getTime() >= new Date(end).getTime()) {
      errors.push({ name: endKey, message: `${startLabel} must be before ${endLabel}.` })
    }
  }
  const duration = config.cbtfDurationMinutes ?? 60
  if (!Number.isInteger(duration) || duration <= 0) {
    errors.push({ name: 'cbtfDurationMinutes', message: 'Exam duration must be a positive whole number of minutes.' })
  } else if (config.availableFrom && config.acceptUntil) {
    const length = new Date(config.acceptUntil).getTime() - new Date(config.availableFrom).getTime()
    if ((config.isSchedulable === true || (config.isSchedulable === undefined && config.cbtfDurationMinutes != null)) && length > 0 && length < duration * 60_000) {
      errors.push({ name: 'acceptUntil', message: `Available From to Accept Until must fit the full ${duration}-minute exam.` })
    }
  }
  return errors
}
