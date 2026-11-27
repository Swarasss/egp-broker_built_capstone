<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-end gap-3">
      <div class="min-w-56">
        <label class="mb-1 block text-sm font-medium" for="workstation-facility">
          Testing facility
        </label>
        <USelect
          id="workstation-facility"
          v-model="selectedFacilityId"
          :items="facilityOptions"
          class="w-full"
        />
      </div>
      <p v-if="summary" class="text-sm text-gray-500" role="status" aria-live="polite">
        {{ summary.counts.total }} total · {{ summary.counts.available }} available ·
        {{ summary.counts.spare }} spare · {{ summary.counts.outOfService }} out of service
      </p>
    </div>

    <p v-if="loading" class="text-sm text-gray-500" role="status" aria-live="polite">
      Loading workstations…
    </p>
    <p v-else-if="!summary" class="text-sm text-gray-500">No testing facility found.</p>

    <template v-else>
      <div class="grid gap-6 lg:grid-cols-[2fr,1fr]">
        <UCard>
          <template #header>
            <div class="flex flex-col gap-1">
              <h2 class="text-lg font-semibold">Workstations</h2>
              <p class="text-sm text-gray-500">
                Select a seat to take it out of service or return it to service. Spare seats are kept
                open so a student can be moved if a workstation breaks.
              </p>
            </div>
          </template>

          <div class="mb-4 flex flex-wrap gap-4 text-xs text-gray-500">
            <span class="inline-flex items-center gap-1">
              <span class="h-3 w-3 rounded bg-green-500" aria-hidden="true" /> In service
            </span>
            <span class="inline-flex items-center gap-1">
              <span class="h-3 w-3 rounded bg-amber-500" aria-hidden="true" /> Spare seat
            </span>
            <span class="inline-flex items-center gap-1">
              <span class="h-3 w-3 rounded bg-red-500" aria-hidden="true" /> Out of service
            </span>
          </div>

          <div
            class="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8"
            role="group"
            aria-label="Workstations"
          >
            <button
              v-for="seat in summary.seats"
              :key="seat.seatNumber"
              type="button"
              class="flex flex-col items-center justify-center rounded-lg border p-2 text-sm transition"
              :class="seatClasses(seat)"
              :aria-label="seatAriaLabel(seat)"
              :aria-pressed="selectedSeatNumber === seat.seatNumber"
              @click="selectedSeatNumber = seat.seatNumber"
            >
              <span class="font-semibold">{{ seat.seatNumber }}</span>
              <span class="mt-1 text-[10px] uppercase tracking-wide">
                {{ seatStateLabel(seat.state) }}
              </span>
            </button>
          </div>
        </UCard>

        <div class="space-y-6">
          <UCard>
            <template #header>
              <h2 class="text-lg font-semibold">Seat details</h2>
            </template>
            <p v-if="!selectedSeat" class="text-sm text-gray-500">
              Select a seat to see its status.
            </p>
            <div v-else class="space-y-3">
              <p class="font-medium">
                Seat {{ selectedSeat.seatNumber }} —
                {{ seatStateLabel(selectedSeat.state) }}
              </p>
              <p v-if="selectedSeat.reason" class="text-sm text-gray-500">
                Reason: {{ selectedSeat.reason }}
              </p>
              <div v-if="selectedSeat.state === 'OUT_OF_SERVICE'">
                <UButton
                  icon="i-lucide-rotate-ccw"
                  label="Return to service"
                  :loading="actionLoading"
                  @click="returnSelectedSeat"
                />
              </div>
              <div v-else>
                <UButton
                  color="error"
                  icon="i-lucide-wrench"
                  label="Take out of service"
                  :loading="actionLoading"
                  @click="openOutOfService"
                />
              </div>
            </div>
          </UCard>

          <UCard>
            <template #header>
              <h2 class="text-lg font-semibold">Spare seats</h2>
            </template>
            <p class="text-sm text-gray-500">
              Keep a few seats open so a student can be moved if a computer breaks. Recommended:
              {{ recommendedSpareCount }}.
            </p>
            <div class="mt-3 flex flex-wrap items-end gap-2">
              <UInput
                :model-value="spareSeatCount"
                type="number"
                min="0"
                :max="summary.totalSeats"
                class="w-24"
                aria-label="Spare seats to keep open"
                @update:model-value="(value) => (spareSeatCount = Number(value) || 0)"
              />
              <UButton label="Save" :loading="spareLoading" @click="saveSpareCount" />
              <UButton
                variant="outline"
                label="Reset"
                :loading="spareLoading"
                @click="resetSpareCount"
              />
            </div>
            <p v-if="summary.spareSeatNumbers.length" class="mt-2 text-xs text-gray-500">
              Spare seats: {{ summary.spareSeatNumbers.join(', ') }}
            </p>
          </UCard>
        </div>
      </div>

      <UCard>
        <template #header>
          <div class="flex flex-col gap-1">
            <h2 class="text-lg font-semibold">Reservations at risk</h2>
            <p class="text-sm text-gray-500">
              These students are on an out-of-service seat and need to be moved to a spare seat.
            </p>
          </div>
        </template>
        <p v-if="!atRisk.length" class="text-sm text-gray-500">No reservations need attention.</p>
        <div v-else class="divide-y divide-gray-200 dark:divide-gray-800">
          <div
            v-for="item in atRisk"
            :key="item.reservationId"
            class="flex flex-wrap items-center justify-between gap-3 py-3"
          >
            <div>
              <p class="font-medium">
                {{ item.studentName || 'Student' }} — {{ item.assignmentTitle }}
              </p>
              <p class="text-xs text-gray-500">
                Seat {{ item.seatNumber }} · {{ formatTime(item.startTime) }} –
                {{ formatTime(item.endTime) }}
              </p>
            </div>
            <UButton
              size="sm"
              icon="i-lucide-arrow-right-left"
              label="Move to spare"
              :loading="movingId === item.reservationId"
              @click="moveToSpare(item.reservationId)"
            />
          </div>
        </div>
      </UCard>
    </template>

    <UModal v-model:open="outOfServiceOpen" title="Take workstation out of service">
      <template #body>
        <p class="text-sm text-gray-500">
          Seat {{ pendingSeatNumber }} will be unavailable for scheduling. Students who are already
          seated or starting soon will be moved to a spare seat automatically; later reservations
          will be listed as at risk.
        </p>
        <label class="mt-3 block text-sm font-medium" for="out-of-service-reason">
          Reason (optional)
        </label>
        <UTextarea
          id="out-of-service-reason"
          v-model="outOfServiceReason"
          placeholder="e.g. Monitor not turning on"
        />
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton variant="ghost" label="Cancel" @click="outOfServiceOpen = false" />
          <UButton
            color="error"
            label="Take out of service"
            :loading="actionLoading"
            @click="confirmOutOfService"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>

<script setup lang="ts">
import { getRecommendedSpareSeatCount } from '@@/shared/utils/cbtf-seats'
import type { CbtfSeatState, CbtfSeatStatusDto } from '@@/shared/models/cbtf'
import { useCbtfWorkstations } from '~/composables/features/admin/useCbtfWorkstations'

definePageMeta({ middleware: ['admin-only'] })

const { setTitle } = useAdminPageTitle()
watchEffect(() => setTitle('Workstations'))
useSeo('admin')

const toast = useToast()

const {
  facilityOptions,
  selectedFacilityId,
  summary,
  loading,
  actionLoading,
  spareLoading,
  movingId,
  loadFacilities,
  takeOutOfService,
  returnToService,
  saveSpareSeats,
  resetSpareSeats,
  moveToSpare: moveReservationToSpare
} = useCbtfWorkstations()

const atRisk = computed(() => summary.value?.atRisk ?? [])
const selectedSeatNumber = ref<number | null>(null)
const selectedSeat = computed(
  () => summary.value?.seats.find((seat) => seat.seatNumber === selectedSeatNumber.value) ?? null
)
const recommendedSpareCount = computed(() =>
  summary.value ? getRecommendedSpareSeatCount(summary.value.totalSeats) : 0
)
const spareSeatCount = ref(0)

watch(
  summary,
  (value) => {
    if (!value) return
    if (selectedSeatNumber.value === null) {
      selectedSeatNumber.value = value.seats[0]?.seatNumber ?? null
    }
    spareSeatCount.value = value.spareSeatCount
  },
  { immediate: true }
)

const outOfServiceOpen = ref(false)
const outOfServiceReason = ref('')
const pendingSeatNumber = ref<number | null>(null)

function seatStateLabel(state: CbtfSeatState): string {
  if (state === 'OUT_OF_SERVICE') return 'Out of service'
  if (state === 'SPARE') return 'Spare seat'
  return 'In service'
}

function seatAriaLabel(seat: CbtfSeatStatusDto): string {
  return `Seat ${seat.seatNumber}: ${seatStateLabel(seat.state)}`
}

function seatClasses(seat: CbtfSeatStatusDto): string {
  const base =
    'flex flex-col items-center justify-center rounded-lg border p-2 text-sm transition'
  if (seat.seatNumber === selectedSeatNumber.value) {
    return `${base} border-primary-500 ring-2 ring-primary-500`
  }
  if (seat.state === 'OUT_OF_SERVICE') {
    return `${base} border-red-300 bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300`
  }
  if (seat.state === 'SPARE') {
    return `${base} border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200`
  }
  return `${base} border-gray-200 hover:border-primary-300 dark:border-gray-800`
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

function openOutOfService() {
  if (!selectedSeat.value) return
  pendingSeatNumber.value = selectedSeat.value.seatNumber
  outOfServiceReason.value = ''
  outOfServiceOpen.value = true
}

async function confirmOutOfService() {
  if (pendingSeatNumber.value === null) return
  const result = await takeOutOfService(
    pendingSeatNumber.value,
    outOfServiceReason.value.trim() || undefined
  )
  if (result) outOfServiceOpen.value = false
}

async function returnSelectedSeat() {
  if (!selectedSeat.value) return
  await returnToService(selectedSeat.value.seatNumber)
}

async function saveSpareCount() {
  await saveSpareSeats(spareSeatCount.value)
}

async function resetSpareCount() {
  await resetSpareSeats()
}

async function moveToSpare(reservationId: string) {
  await moveReservationToSpare(reservationId)
}

onMounted(() => {
  void loadFacilities()
})
</script>
