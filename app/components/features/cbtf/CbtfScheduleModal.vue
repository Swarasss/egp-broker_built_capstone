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

          <div class="space-y-1">
            <p class="text-lg font-bold text-neutral-900 dark:text-neutral-100">
              {{ assignment?.title || existingReservation.assignmentTitle }}
            </p>
            <p class="text-sm text-neutral-600 dark:text-neutral-400">
              {{
                formatReservationTime(existingReservation.startTime, existingReservation.endTime)
              }}
            </p>
          </div>

          <div
            class="flex items-center gap-2 pt-2 border-t border-neutral-200 dark:border-neutral-800"
          >
            <UIcon name="i-lucide-armchair" class="w-5 h-5 text-primary-500" />
            <span class="text-sm font-semibold text-neutral-800 dark:text-neutral-200">
              Workstation Seat #{{ existingReservation.seatNumber }}
            </span>
          </div>
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
            <div v-for="s in [1, 2, 3]" :key="s" class="flex items-center gap-2">
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
              <div v-if="s < 3" class="w-8 h-0.5 bg-neutral-200 dark:bg-neutral-800" />
            </div>
          </div>
          <span class="text-xs font-medium text-neutral-500">
            Step {{ currentStep }} of 3: {{ stepTitle }}
          </span>
        </div>

        <!-- Loading State -->
        <div v-if="loadingAvailability" class="py-12 text-center space-y-3">
          <UIcon name="i-lucide-loader-2" class="w-8 h-8 mx-auto animate-spin text-primary-500" />
          <p class="text-sm text-neutral-500">Finding available testing center slots…</p>
        </div>

        <p v-else-if="availabilityMessage" role="status" class="p-6 text-center text-sm text-neutral-600 dark:text-neutral-400">
          {{ availabilityMessage }}
        </p>

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

        <!-- Wizard Step 1: Select Half-Day Block -->
        <div v-else-if="currentStep === 1" class="space-y-4">
          <p class="text-sm text-neutral-600 dark:text-neutral-400">
            Select an upcoming half-day block within your exam window:
          </p>

          <div
            v-if="!availabilityData?.blocks || availabilityData.blocks.length === 0"
            class="p-6 text-center space-y-3"
          >
            <div
              v-if="isRescheduling && existingReservation"
              class="p-4 rounded-xl border border-primary-500/30 bg-primary-50/50 dark:bg-primary-950/30 text-left space-y-2"
            >
              <div
                class="flex items-center gap-2 text-primary-700 dark:text-primary-300 font-semibold text-sm"
              >
                <UIcon name="i-lucide-shield-check" class="w-5 h-5 text-primary-500 shrink-0" />
                <span>Current Reservation Protected</span>
              </div>
              <p class="text-xs text-neutral-600 dark:text-neutral-400">
                No alternative open slots were found within your exam window. Your existing
                reservation for
                <strong class="text-neutral-800 dark:text-neutral-200">
                  {{
                    formatReservationTime(
                      existingReservation.startTime,
                      existingReservation.endTime
                    )
                  }}
                </strong>
                at
                <strong class="text-neutral-800 dark:text-neutral-200">
                  Workstation Seat #{{ existingReservation.seatNumber }}
                </strong>
                remains active.
              </p>
            </div>
            <p v-else class="text-neutral-500 text-sm">
              No testing-center availability is currently available within your exam window.
            </p>
          </div>

          <div v-else class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              v-for="block in availabilityData.blocks"
              :key="block.id"
              type="button"
              class="p-4 rounded-xl border text-left transition-all cursor-pointer space-y-3 relative overflow-hidden"
              :class="[
                selectedBlockId === block.id
                  ? 'border-primary-500 bg-primary-50/40 dark:bg-primary-950/30 ring-2 ring-primary-500'
                  : 'border-neutral-200 dark:border-neutral-800 hover:border-neutral-300 dark:hover:border-neutral-700'
              ]"
              @click="chooseBlock(block)"
            >
              <!-- Top Row: Block Title & Date -->
              <div class="flex items-start justify-between gap-2">
                <div class="space-y-0.5">
                  <div class="flex items-center gap-2">
                    <p class="font-bold text-sm text-neutral-900 dark:text-neutral-100">
                      {{ block.label }}
                    </p>
                    <UBadge
                      v-if="block.isCurrentBlock"
                      color="success"
                      variant="subtle"
                      size="xs"
                      class="animate-pulse"
                    >
                      In Progress
                    </UBadge>
                  </div>
                  <p class="break-words text-xs text-neutral-500 dark:text-neutral-400">
                    {{ block.dateLabel }} · {{ formatTimezoneLabel(block.timezone) }}
                  </p>
                </div>

              </div>
              <p class="text-xs text-neutral-500">Available arrival times</p>
            </button>
          </div>
        </div>

        <!-- Wizard Step 2: Hourly Slot Selection -->
        <div v-else-if="currentStep === 2" class="space-y-4">
          <p class="text-sm text-neutral-600 dark:text-neutral-400">
            Pick an arrival time for
            <strong>{{ selectedBlock?.label }}, {{ selectedBlock?.dateLabel }}</strong>.
            <span v-if="selectedBlock"> Times shown in {{ formatTimezoneLabel(selectedBlock.timezone) }}.</span>
          </p>

          <div
            v-if="!availabilityData?.hourlySlots || availabilityData.hourlySlots.length === 0"
            class="p-6 text-center text-neutral-500 text-sm"
          >
            No open time slots found for this block.
          </div>

          <div v-else class="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <button
              v-for="slot in availabilityData.hourlySlots"
              :key="slot.startTime"
              type="button"
              class="p-3 rounded-lg border text-center transition-all cursor-pointer font-medium text-sm flex flex-col items-center justify-center gap-1"
              :class="[
                selectedSlot?.startTime === slot.startTime
                  ? 'border-primary-500 bg-primary-600 text-white font-bold shadow-sm'
                  : 'border-neutral-200 dark:border-neutral-800 hover:border-neutral-300 dark:hover:border-neutral-700 text-neutral-900 dark:text-neutral-100'
              ]"
              @click="chooseSlot(slot)"
            >
              <UIcon name="i-lucide-clock" class="w-4 h-4" />
              <span>{{ slot.formattedTime }}</span>
            </button>
          </div>
        </div>

        <!-- Wizard Step 3: Review & Confirm -->
        <div v-else-if="currentStep === 3" class="space-y-4">
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
                <p class="text-xs text-neutral-500 uppercase">Block & Date</p>
                <p class="font-semibold text-neutral-900 dark:text-neutral-100 text-sm">
                  {{ selectedBlock?.label }}, {{ selectedBlock?.dateLabel }}
                </p>
              </div>
              <div>
                <p class="text-xs text-neutral-500 uppercase">Time Slot</p>
                <p class="font-semibold text-neutral-900 dark:text-neutral-100 text-sm">
                  {{
                    selectedBlock
                      ? `${selectedSlot?.formattedTime} · ${formatTimezoneLabel(selectedBlock.timezone)}`
                      : selectedSlot?.formattedTime
                  }}
                </p>
              </div>
            </div>

            <div
              class="pt-2 border-t border-neutral-200 dark:border-neutral-800 flex items-center gap-2 text-xs text-neutral-500"
            >
              <UIcon name="i-lucide-info" class="w-4 h-4 text-primary-500 shrink-0" />
              <span>Workstation seat will be assigned deterministically upon confirmation.</span>
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
              v-if="currentStep < 3"
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
  CbtfStudentBlock,
  CbtfStudentStart
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

const selectedBlockId = ref<string>('')
const selectedSlot = ref<CbtfStudentStart | null>(null)
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
  return status && status !== 'AVAILABLE' ? availabilityMessages[status] : null
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
      return 'Select Half-Day Block'
    case 2:
      return 'Pick Time Slot'
    case 3:
      return 'Confirm'
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

const selectedBlock = computed<CbtfStudentBlock | undefined>(() => {
  return availabilityData.value?.blocks?.find((b) => b.id === selectedBlockId.value)
})

const isNextDisabled = computed(() => {
  if (loadingAvailability.value || availabilityMessage.value) return true
  if (currentStep.value === 1) return !selectedBlock.value
  if (currentStep.value === 2) return !selectedSlot.value
  return false
})

// Load availability when opening or changing block
const loadAvailability = async (blockId?: string) => {
  if (!props.assignment?.id) return
  loadingAvailability.value = true
  availabilityError.value = null
  try {
    const data = await fetchAvailability(
      props.assignment.id,
      blockId || selectedBlockId.value || undefined,
      undefined,
      isRescheduling.value ? props.existingReservation?.id : undefined
    )
    availabilityData.value = data
    if (!selectedBlockId.value && data.blocks && data.blocks.length > 0) {
      selectedBlockId.value = data.blocks[0].id
    }
  } catch (err) {
    const response = err as { data?: { data?: { availabilityStatus?: string } } } | null
    availabilityData.value = null
    availabilityError.value = response?.data?.data?.availabilityStatus === 'INVALID_ASSIGNMENT_WINDOW'
      ? 'INVALID_ASSIGNMENT_WINDOW'
      : 'REQUEST_FAILED'
  } finally {
    loadingAvailability.value = false
  }
}

const chooseBlock = async (block: CbtfStudentBlock) => {
  selectedBlockId.value = block.id
  selectedSlot.value = null
  currentStep.value = 2
  await loadAvailability(block.id)
}

const goToNextStep = () => {
  if (currentStep.value === 1 && selectedBlock.value) {
    return chooseBlock(selectedBlock.value)
  }
  currentStep.value++
}

const chooseSlot = (slot: CbtfStudentStart) => {
  selectedSlot.value = slot
  currentStep.value = 3
}

const startRescheduling = () => {
  isRescheduling.value = true
  currentStep.value = 1
  selectedBlockId.value = ''
  selectedSlot.value = null
  confirmedReservation.value = null
  loadAvailability()
}

const handleCancelRescheduling = () => {
  if (isRescheduling.value && props.existingReservation) {
    isRescheduling.value = false
    currentStep.value = 1
    selectedBlockId.value = ''
    selectedSlot.value = null
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
  if (isOpen) {
    confirmedReservation.value = null
    isRescheduling.value = false
    currentStep.value = 1
    selectedSlot.value = null
    selectedBlockId.value = ''
    availabilityData.value = null
    availabilityError.value = null
    if (!props.existingReservation) {
      loadAvailability()
    }
  }
})
</script>
