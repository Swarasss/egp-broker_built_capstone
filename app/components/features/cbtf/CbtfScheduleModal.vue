<template>
  <UModal v-model:open="open" :title="modalTitle" :description="modalDescription">
    <template #body>
      <!-- Mode A: Active / Missed Reservation View -->
      <div v-if="existingReservation && !isRescheduling" class="space-y-6">
        <div
          class="p-4 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/50 space-y-4"
        >
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold uppercase tracking-wider text-neutral-500">
              Current Reservation
            </span>
            <UBadge
              :color="statusBadgeColor(existingReservation.status)"
              variant="subtle"
              size="sm"
            >
              {{ existingReservation.status }}
            </UBadge>
          </div>

          <p class="text-lg font-bold text-neutral-900 dark:text-neutral-100">
            {{ assignment?.title || existingReservation.assignmentTitle }}
          </p>

          <dl class="space-y-3 text-sm text-neutral-800 dark:text-neutral-200">
            <div>
              <dt class="font-semibold">Testing Center</dt>
              <dd>{{ existingReservation.facilityName || 'Testing center unavailable' }}</dd>
            </div>
            <div>
              <dt class="font-semibold">Exam Time</dt>
              <dd>
                {{ formatReservationTime(existingReservation.startTime, existingReservation.endTime) }}
              </dd>
            </div>
            <div>
              <dt class="font-semibold">Seat</dt>
              <dd>Workstation #{{ existingReservation.seatNumber }}</dd>
            </div>
          </dl>
        </div>

        <div
          v-if="existingReservation.status === 'MISSED'"
          class="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400 text-xs flex items-start gap-2"
        >
          <UIcon name="i-lucide-alert-circle" class="w-4 h-4 shrink-0 mt-0.5" />
          <span
            >You missed your scheduled exam time. You may reschedule for an open slot within the
            test window.</span
          >
        </div>

        <div
          v-if="existingReservation.status === 'CANCELLED'"
          class="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400 text-xs flex items-start gap-2"
        >
          <UIcon name="i-lucide-calendar-x" class="w-4 h-4 shrink-0 mt-0.5" />
          <span
            >This reservation was cancelled. You may reschedule for an open slot within the
            test window.</span
          >
        </div>

        <div class="flex flex-col sm:flex-row gap-3 justify-end pt-2">
          <UButton
            v-if="existingReservation.status === 'SCHEDULED'"
            color="error"
            variant="ghost"
            label="Cancel Reservation"
            icon="i-lucide-calendar-x"
            :loading="cancelling"
            @click="handleCancel"
          />
          <UButton
            color="primary"
            variant="solid"
            label="Reschedule Exam"
            icon="i-lucide-calendar-clock"
            @click="startRescheduling"
          />
        </div>
      </div>

      <!-- Mode B: Progressive Narrowing Wizard (Stepper) -->
      <div v-else class="space-y-6">
        <!-- Stepper Indicator -->
        <div
          class="flex items-center justify-between pb-3 border-b border-neutral-200 dark:border-neutral-800"
        >
          <div class="flex items-center gap-2">
            <div v-for="s in [1, 2, 3, 4]" :key="s" class="flex items-center gap-2">
              <div
                class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors"
                :class="[
                  currentStep === s
                    ? 'bg-primary-600 text-white'
                    : currentStep > s
                      ? 'bg-primary-100 dark:bg-primary-950 text-primary-600 dark:text-primary-400 border border-primary-500/30'
                      : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-400'
                ]"
              >
                <UIcon v-if="currentStep > s" name="i-lucide-check" class="w-4 h-4" />
                <span v-else>{{ s }}</span>
              </div>
              <div v-if="s < 4" class="w-8 h-0.5 bg-neutral-200 dark:bg-neutral-800" />
            </div>
          </div>
          <span class="text-xs font-medium text-neutral-500">
            Step {{ currentStep }} of 4: {{ stepTitle }}
          </span>
        </div>

        <!-- Loading State -->
        <div v-if="loadingAvailability" class="py-12 text-center space-y-3">
          <UIcon name="i-lucide-loader-2" class="w-8 h-8 mx-auto animate-spin text-primary-500" />
          <p class="text-sm text-neutral-500">Finding available testing center slots…</p>
        </div>

        <div v-else-if="availabilityMessage" role="status" class="space-y-2 p-6 text-center text-sm text-neutral-600 dark:text-neutral-400">
          <p>{{ availabilityMessage }}</p>
          <div v-if="isRescheduling && existingReservation" class="space-y-1">
            <p class="font-semibold">Current Reservation Protected</p>
            <p v-if="!availabilityError && availabilityData?.reservationWindowStatus !== 'CLOSED' && availabilityData?.reservationWindowStatus !== 'NOT_YET_OPEN'">
              No alternative open slots were found.
            </p>
            <p>Your reservation at Workstation Seat #{{ existingReservation.seatNumber }} has not changed.</p>
          </div>
        </div>

        <!-- Success Screen (Post-Confirmation) -->
        <div v-else-if="confirmedReservation" class="py-8 text-center space-y-4">
          <div
            class="w-16 h-16 rounded-full bg-green-100 dark:bg-green-950/60 text-green-600 dark:text-green-400 flex items-center justify-center mx-auto"
          >
            <UIcon name="i-lucide-check-circle-2" class="w-10 h-10" />
          </div>
          <div>
            <h4 class="text-xl font-bold text-neutral-900 dark:text-neutral-100">
              Exam Confirmed!
            </h4>
            <p class="text-sm font-semibold">{{ confirmedReservation.facilityName }}</p>
            <p class="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
              {{
                formatReservationTime(confirmedReservation.startTime, confirmedReservation.endTime)
              }}
            </p>
          </div>

          <div
            class="p-4 rounded-xl border border-primary-500/30 bg-primary-50/50 dark:bg-primary-950/30 max-w-sm mx-auto"
          >
            <p
              class="text-xs font-semibold uppercase tracking-wider text-primary-600 dark:text-primary-400"
            >
              Assigned Workstation
            </p>
            <p class="text-3xl font-extrabold text-neutral-900 dark:text-neutral-100 mt-1">
              Seat #{{ confirmedReservation.seatNumber }}
            </p>
            <p class="text-xs text-neutral-500 mt-2">
              Please arrive 5–10 minutes early with your student photo ID card.
            </p>
          </div>

          <UButton color="primary" label="Done" class="mt-4" @click="open = false" />
        </div>

        <div v-else-if="currentStep === 1" class="space-y-4">
          <p class="text-sm text-neutral-600 dark:text-neutral-400">
            Morning starts before 12:30 PM. Afternoon starts at 12:30 PM or later.
          </p>
          <div class="grid grid-cols-2 gap-3">
            <div v-for="period in periods" :key="period.value" class="space-y-1">
              <UButton
                block
                variant="outline"
                :label="period.label"
                :disabled="!availabilityData?.schedulingChoices?.[period.value]?.length"
                @click="choosePeriod(period.value)"
              />
              <p v-if="!availabilityData?.schedulingChoices?.[period.value]?.length" class="text-xs text-neutral-500">
                No {{ period.value }} availability.
              </p>
            </div>
          </div>
        </div>

        <div v-else-if="currentStep === 2" class="space-y-4">
          <p class="text-sm text-neutral-600 dark:text-neutral-400">
            Available {{ selectedPeriod }} days closest to the end of your exam window.
          </p>
          <p v-if="!availableDays.length" role="status" class="text-sm text-neutral-500">
            No {{ selectedPeriod }} availability. Go back to choose a different time of day.
          </p>
          <div v-else class="grid grid-cols-2 gap-3">
            <UButton
              v-for="day in availableDays"
              :key="day.date"
              block
              variant="outline"
              :label="day.label"
              @click="chooseDay(day.date)"
            />
          </div>
        </div>

        <div v-else-if="currentStep === 3" class="space-y-4">
          <p class="text-sm text-neutral-600 dark:text-neutral-400">
            Choose an available start on <strong>{{ selectedDay?.label }}</strong>.
          </p>
          <p v-if="!selectedDay?.times.length" role="status" class="text-sm text-neutral-500">
            No suggested times are available for this day. Go back to choose another day.
          </p>
          <div v-else class="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <UButton
              v-for="slot in selectedDay.times"
              :key="slot.startTime"
              block
              variant="outline"
              @click="chooseSlot(slot)"
            >
              <span class="flex flex-col text-center">
                <span>{{ slot.formattedTime }}</span>
                <span class="text-xs">{{ formatTimezoneLabel(slot.timezone) }}</span>
              </span>
            </UButton>
          </div>
        </div>

        <!-- Wizard Step 4: Review & Confirm -->
        <div v-else-if="currentStep === 4" class="space-y-4">
          <div
            class="p-5 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/50 space-y-3"
          >
            <div
              class="flex items-center justify-between pb-2 border-b border-neutral-200 dark:border-neutral-800"
            >
              <span class="text-xs font-semibold uppercase tracking-wider text-neutral-500">
                Reservation Summary
              </span>
              <div class="flex items-center gap-2">
                <UBadge
                  v-if="(availabilityData?.accommodation?.timeMultiplier ?? 1) > 1"
                  color="primary"
                  variant="soft"
                  size="xs"
                >
                  Time accommodation {{ availabilityData?.accommodation?.timeMultiplier }}×
                </UBadge>
                <UBadge color="neutral" variant="subtle" size="xs">
                  {{ effectiveDurationMinutes }} Minutes Duration
                </UBadge>
              </div>
            </div>

            <div class="space-y-1">
              <p class="text-xs text-neutral-500 uppercase">Testing Center</p>
              <p class="font-semibold">Assigned when you confirm</p>
              <p class="text-xs text-neutral-500 uppercase">Assignment</p>
              <p class="font-bold text-neutral-900 dark:text-neutral-100">
                {{ assignment?.title || availabilityData?.assignmentTitle }}
              </p>
            </div>

            <div class="grid grid-cols-2 gap-4 pt-1">
              <div>
                <p class="text-xs text-neutral-500 uppercase">Exam Day</p>
                <p class="font-semibold text-neutral-900 dark:text-neutral-100 text-sm">
                  {{ selectedDay?.label }}
                </p>
              </div>
              <div>
                <p class="text-xs text-neutral-500 uppercase">Time Slot</p>
                <p class="font-semibold text-neutral-900 dark:text-neutral-100 text-sm">
                  {{ selectedSlot && `${selectedSlot.formattedTime} · ${formatTimezoneLabel(selectedSlot.timezone)}` }}
                </p>
              </div>
            </div>

            <div
              class="pt-2 border-t border-neutral-200 dark:border-neutral-800 flex items-center gap-2 text-xs text-neutral-500"
            >
              <UIcon name="i-lucide-info" class="w-4 h-4 text-primary-500 shrink-0" />
              <span>Your workstation will be assigned when you confirm.</span>
            </div>
          </div>
        </div>

        <!-- Wizard Footer Navigation -->
        <div
          v-if="!confirmedReservation"
          class="flex items-center justify-between pt-4 border-t border-neutral-200 dark:border-neutral-800"
        >
          <UButton
            v-if="currentStep > 1"
            color="neutral"
            variant="ghost"
            label="Back"
            icon="i-lucide-arrow-left"
            @click="currentStep--"
          />
          <UButton
            v-else-if="isRescheduling && existingReservation"
            color="neutral"
            variant="ghost"
            label="Back to Reservation"
            icon="i-lucide-arrow-left"
            @click="handleCancelRescheduling"
          />
          <div v-else />

          <div class="flex gap-2">
            <UButton
              color="neutral"
              variant="outline"
              :label="isRescheduling && existingReservation ? 'Keep Current Reservation' : 'Cancel'"
              @click="handleCancelRescheduling"
            />
            <UButton
              v-if="currentStep < 4"
              color="primary"
              label="Next"
              trailing-icon="i-lucide-arrow-right"
              :disabled="isNextDisabled"
              @click="goToNextStep"
            />
            <UButton
              v-else
              color="primary"
              :label="isRescheduling ? 'Confirm Reschedule' : 'Confirm Reservation'"
              icon="i-lucide-check"
              :loading="booking"
              @click="handleConfirmBooking"
            />
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import type { AssignmentRow } from '@@/shared/models/assignment'
import type {
  CbtfReservationDto,
  CbtfAvailabilityStatus,
  CbtfSchedulingDay,
  CbtfSchedulingPeriod
} from '@@/shared/models/cbtf'
import { useCbtfStudent, type CbtfAvailabilityData } from '~/composables/features/useCbtfStudent'

const timezoneLabels: Readonly<Record<string, string>> = {
  'America/New_York': 'Eastern (ET)',
  'America/Chicago': 'Central (CT)',
  'America/Denver': 'Mountain (MT)',
  'America/Los_Angeles': 'Pacific (PT)',
  'America/Phoenix': 'Arizona (MST)',
  'America/Anchorage': 'Alaska (AKT)',
  'Pacific/Honolulu': 'Hawaii (HST)'
}

function formatTimezoneLabel(timezone: string): string {
  return timezoneLabels[timezone] ?? timezone.slice(timezone.lastIndexOf('/') + 1).replaceAll('_', ' ')
}

const props = defineProps<{
  assignment: AssignmentRow | null
  existingReservation?: CbtfReservationDto | null
}>()

const open = defineModel<boolean>('open', { required: true })

const emit = defineEmits<{
  reserved: [reservation: CbtfReservationDto]
  cancelled: []
}>()

const { fetchAvailability, createReservation, rescheduleReservation, cancelReservation } =
  useCbtfStudent()

// State
const isRescheduling = ref(false)
const currentStep = ref(1)
const loadingAvailability = ref(false)
const booking = ref(false)
const cancelling = ref(false)

const periods: { value: CbtfSchedulingPeriod; label: string }[] = [
  { value: 'morning', label: 'Morning' },
  { value: 'afternoon', label: 'Afternoon' }
]
const selectedPeriod = ref<CbtfSchedulingPeriod | null>(null)
const selectedDate = ref('')
const selectedSlot = ref<CbtfSchedulingDay['times'][number] | null>(null)
let availabilityRequest = 0
const availabilityData = ref<CbtfAvailabilityData | null>(null)
const availabilityError = ref<'INVALID_ASSIGNMENT_WINDOW' | 'REQUEST_FAILED' | null>(null)
const availabilityMessages: Record<Exclude<CbtfAvailabilityStatus, 'AVAILABLE'> | 'REQUEST_FAILED', string> = {
  INVALID_ASSIGNMENT_WINDOW: 'This exam is not fully configured for CBTF scheduling. Please contact your instructor.',
  RESERVATION_NOT_OPEN: 'The reservation window for this exam has not opened yet.',
  RESERVATION_CLOSED: 'The reservation window for this exam is currently closed.',
  NO_CONFIGURED_FACILITY_HOURS: 'No testing center is configured with operating hours that overlap this exam window.',
  NO_AVAILABLE_SEATS: 'No testing-center availability is currently available within your exam window.',
  NO_FUTURE_STARTS: 'There are no remaining exam start times within your exam window.',
  ARRIVAL_LIMIT_REACHED: 'All remaining testing-center arrival times within your exam window are full.',
  STUDENT_CONFLICT: 'The remaining available exam times overlap your existing testing-center reservation.',
  REQUEST_FAILED: 'Testing-center availability could not be loaded. Please try again.'
}

const availabilityMessage = computed(() => {
  const status = availabilityError.value ?? availabilityData.value?.availabilityStatus
  if (status && status !== 'AVAILABLE') return availabilityMessages[status]
  const choices = availabilityData.value?.schedulingChoices
  return availabilityData.value && !choices?.morning.length && !choices?.afternoon.length
    ? availabilityMessages.NO_AVAILABLE_SEATS
    : null
})

const effectiveDurationMinutes = computed(
  () =>
    availabilityData.value?.accommodation?.effectiveDurationMinutes ??
    props.assignment?.cbtfDurationMinutes ??
    60
)
const confirmedReservation = ref<CbtfReservationDto | null>(null)

// Step titles
const stepTitle = computed(() => {
  switch (currentStep.value) {
    case 1:
      return 'Choose a time of day'
    case 2:
      return 'Choose a day'
    case 3:
      return 'Choose a preferred time'
    case 4:
      return 'Review and confirm'
    default:
      return ''
  }
})

const modalTitle = computed(() => {
  if (props.existingReservation && !isRescheduling.value) {
    return 'CBTF Exam Reservation'
  }
  return isRescheduling.value ? 'Reschedule CBTF Exam' : 'Schedule CBTF Exam'
})

const modalDescription = computed(() => {
  return props.assignment?.title || 'Testing Center Reservation'
})

const availableDays = computed(() =>
  selectedPeriod.value ? availabilityData.value?.schedulingChoices?.[selectedPeriod.value] ?? [] : []
)
const selectedDay = computed(() => availableDays.value.find((day) => day.date === selectedDate.value))

const isNextDisabled = computed(() => {
  if (loadingAvailability.value || availabilityMessage.value) return true
  if (currentStep.value === 1) return !availableDays.value.length
  if (currentStep.value === 2) return !selectedDay.value
  return !selectedSlot.value
})

const loadAvailability = async () => {
  if (!props.assignment?.id) return
  const request = ++availabilityRequest
  loadingAvailability.value = true
  availabilityError.value = null
  try {
    const data = await fetchAvailability(
      props.assignment.id,
      undefined,
      undefined,
      isRescheduling.value ? props.existingReservation?.id : undefined,
      'narrowing'
    )
    if (request === availabilityRequest) availabilityData.value = data
  } catch (err) {
    if (request !== availabilityRequest) return
    const response = err as { data?: { data?: { availabilityStatus?: string } } } | null
    availabilityData.value = null
    availabilityError.value = response?.data?.data?.availabilityStatus === 'INVALID_ASSIGNMENT_WINDOW'
      ? 'INVALID_ASSIGNMENT_WINDOW'
      : 'REQUEST_FAILED'
  } finally {
    if (request === availabilityRequest) loadingAvailability.value = false
  }
}

const choosePeriod = (period: CbtfSchedulingPeriod) => {
  if (period !== selectedPeriod.value) {
    selectedDate.value = ''
    selectedSlot.value = null
  }
  selectedPeriod.value = period
  currentStep.value = 2
}

const chooseDay = (date: string) => {
  if (date !== selectedDate.value) selectedSlot.value = null
  selectedDate.value = date
  currentStep.value = 3
}

const goToNextStep = () => {
  if (!isNextDisabled.value) currentStep.value++
}

const chooseSlot = (slot: CbtfSchedulingDay['times'][number]) => {
  selectedSlot.value = slot
  currentStep.value = 4
}

const resetScheduling = () => {
  availabilityRequest++
  loadingAvailability.value = false
  currentStep.value = 1
  selectedPeriod.value = null
  selectedDate.value = ''
  selectedSlot.value = null
  confirmedReservation.value = null
  availabilityData.value = null
  availabilityError.value = null
}

const startRescheduling = () => {
  resetScheduling()
  isRescheduling.value = true
  loadAvailability()
}

const handleCancelRescheduling = () => {
  if (isRescheduling.value && props.existingReservation) {
    isRescheduling.value = false
    resetScheduling()
  } else {
    open.value = false
  }
}

const handleConfirmBooking = async () => {
  if (!props.assignment?.id || !selectedSlot.value) return
  booking.value = true
  try {
    let result: CbtfReservationDto
    if (isRescheduling.value && props.existingReservation?.id) {
      result = await rescheduleReservation(
        props.existingReservation.id,
        selectedSlot.value.startTime
      )
    } else {
      result = await createReservation(
        props.assignment.id,
        selectedSlot.value.startTime
      )
    }
    confirmedReservation.value = result
    emit('reserved', result)
  } catch (err) {
    console.error(err)
  } finally {
    booking.value = false
  }
}

const handleCancel = async () => {
  if (!props.existingReservation?.id) return
  if (!confirm('Are you sure you want to cancel this exam reservation?')) return
  cancelling.value = true
  try {
    await cancelReservation(props.existingReservation.id)
    emit('cancelled')
    open.value = false
  } catch (err) {
    console.error(err)
  } finally {
    cancelling.value = false
  }
}

const formatReservationTime = (startStr: string, endStr: string) => {
  const start = new Date(startStr)
  const end = new Date(endStr)
  return `${start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}, ${start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} – ${end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

const statusBadgeColor = (status: string) => {
  switch (status) {
    case 'SCHEDULED':
      return 'primary'
    case 'CHECKED_IN':
      return 'success'
    case 'CHECKED_OUT':
      return 'neutral'
    case 'MISSED':
      return 'error'
    case 'CANCELLED':
      return 'warning'
    default:
      return 'neutral'
  }
}

watch(open, (isOpen) => {
  resetScheduling()
  isRescheduling.value = false
  if (isOpen && !props.existingReservation) loadAvailability()
}, { immediate: true })
</script>
