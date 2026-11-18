<template>
  <div class="space-y-6">
    <div class="flex flex-wrap gap-2">
      <UButton
        :variant="tab === 'students' ? 'solid' : 'outline'"
        :color="tab === 'students' ? 'primary' : 'neutral'"
        icon="i-lucide-accessibility"
        label="Student Accommodations"
        @click="selectTab('students')"
      />
      <UButton
        :variant="tab === 'seats' ? 'solid' : 'outline'"
        :color="tab === 'seats' ? 'primary' : 'neutral'"
        icon="i-lucide-armchair"
        label="Seat Certifications"
        @click="selectTab('seats')"
      />
    </div>

    <!-- Student accommodations -->
    <UCard v-if="tab === 'students'">
      <template #header>
        <div class="flex flex-col gap-1">
          <h2 class="text-lg font-semibold">Student accommodations</h2>
          <p class="text-sm text-gray-500">
            Assign time accommodations and required seat certifications. Only test-center staff can change
            these; students can view them but cannot edit them.
          </p>
        </div>
      </template>

      <div class="grid gap-6 lg:grid-cols-2">
        <div class="space-y-4">
          <form class="flex gap-2" @submit.prevent="lookupStudent">
            <UInput
              v-model="searchEmail"
              type="email"
              placeholder="Student email (e.g. demo@example.com)"
              class="flex-1"
            />
            <UButton type="submit" icon="i-lucide-search" :loading="searching" label="Find" />
          </form>
          <p v-if="searchError" class="text-sm text-red-500">{{ searchError }}</p>

          <div v-if="selectedUser" class="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
            <p class="font-medium">{{ selectedUser.firstName }} {{ selectedUser.lastName }}</p>
            <p class="text-xs text-gray-500">
              {{ selectedUser.email }} · {{ selectedUser.studentId || 'No student ID' }}
            </p>

            <div class="mt-4 space-y-4">
              <div>
                <label class="mb-1 block text-sm font-medium">Time accommodation</label>
                <div class="flex flex-wrap items-center gap-2">
                  <USelect
                    v-model="form.timeMultiplier"
                    :items="multiplierOptions"
                    class="w-32"
                  />
                  <span class="text-xs text-gray-500">1.0 = standard time</span>
                </div>
              </div>

              <div>
                <label class="mb-1 block text-sm font-medium">Required seat certifications</label>
                <div class="flex flex-wrap gap-3">
                  <UCheckbox
                    v-for="property in seatProperties"
                    :key="property.value"
                    :model-value="form.requiredSeatProperties.includes(property.value)"
                    :label="property.label"
                    @update:model-value="(checked) => toggleProperty(form.requiredSeatProperties, property.value, checked)"
                  />
                </div>
                <p class="mt-1 text-xs text-gray-500">
                  Students with no requirements are never assigned certified seats.
                </p>
              </div>

              <div>
                <label class="mb-1 block text-sm font-medium">Notes</label>
                <UTextarea v-model="form.notes" placeholder="Optional accommodation notes" />
              </div>

              <div class="flex gap-2">
                <UButton
                  icon="i-lucide-save"
                  label="Save accommodation"
                  :loading="saving"
                  @click="saveAccommodation"
                />
                <UButton
                  v-if="editingExisting"
                  variant="ghost"
                  color="error"
                  icon="i-lucide-trash-2"
                  label="Remove"
                  :loading="saving"
                  @click="removeSelectedAccommodation"
                />
              </div>
            </div>
          </div>
        </div>

        <div>
          <h3 class="mb-2 text-sm font-semibold">Current accommodations</h3>
          <p v-if="!accommodations?.data?.length" class="text-sm text-gray-500">
            No accommodations assigned yet.
          </p>
          <div
            v-for="item in accommodations?.data ?? []"
            :key="item.userId"
            class="flex items-start justify-between gap-3 border-b border-gray-200 py-3 last:border-b-0 dark:border-gray-800"
          >
            <div>
              <p class="font-medium">{{ item.studentName }}</p>
              <p class="text-xs text-gray-500">
                {{ item.studentEmail }} · {{ item.studentId || 'No student ID' }}
              </p>
              <div class="mt-1 flex flex-wrap gap-1">
                <UBadge v-if="item.timeMultiplier > 1" color="primary" variant="soft">
                  {{ item.timeMultiplier }}× time accommodation
                </UBadge>
                <UBadge
                  v-for="property in item.requiredSeatProperties"
                  :key="property"
                  color="neutral"
                  variant="soft"
                >
                  {{ property }}
                </UBadge>
                <UBadge v-if="item.notes" color="neutral" variant="subtle">{{ item.notes }}</UBadge>
              </div>
            </div>
            <div class="flex gap-1">
              <UButton
                size="xs"
                variant="ghost"
                icon="i-lucide-pencil"
                @click="editAccommodation(item)"
              />
              <UButton
                size="xs"
                variant="ghost"
                color="error"
                icon="i-lucide-trash-2"
                @click="removeAccommodation(item.userId)"
              />
            </div>
          </div>
        </div>
      </div>
    </UCard>

    <!-- Seat certifications -->
    <UCard v-else>
      <template #header>
        <div class="flex flex-col gap-1">
          <h2 class="text-lg font-semibold">Seat certifications</h2>
          <p class="text-sm text-gray-500">
            {{ seatMap?.data?.facilityName || 'Testing facility' }} ·
            {{ seatMap?.data?.totalSeats || 0 }} seats. Select a seat to tag it. Certified seats are
            reserved for students whose accommodation requires them.
          </p>
        </div>
      </template>

      <div class="grid gap-6 lg:grid-cols-2">
        <div>
          <div class="grid grid-cols-6 gap-2 sm:grid-cols-8">
            <button
              v-for="seat in seats"
              :key="seat.seatNumber"
              type="button"
              class="flex flex-col items-center justify-center rounded-lg border p-2 text-sm transition"
              :class="
                seat.seatNumber === selectedSeatNumber
                  ? 'border-primary-500 bg-primary-50 dark:bg-primary-950'
                  : 'border-gray-200 hover:border-primary-300 dark:border-gray-800'
              "
              @click="selectedSeatNumber = seat.seatNumber"
            >
              <span class="font-semibold">{{ seat.seatNumber }}</span>
              <span
                v-if="seat.properties.length"
                class="mt-1 h-1.5 w-1.5 rounded-full bg-primary-500"
              />
            </button>
          </div>
        </div>

        <div>
          <div
            v-if="selectedSeat"
            class="rounded-lg border border-gray-200 p-4 dark:border-gray-800"
          >
            <p class="font-medium">Seat {{ selectedSeat.seatNumber }}</p>
            <div class="mt-3 flex flex-wrap gap-3">
              <UCheckbox
                v-for="property in seatProperties"
                :key="property.value"
                :model-value="selectedSeat.properties.includes(property.value)"
                :label="property.label"
                @update:model-value="(checked) => toggleSelectedSeatProperty(property.value, checked)"
              />
            </div>
          </div>
          <p v-else class="text-sm text-gray-500">Select a seat to edit its certifications.</p>

          <UButton
            class="mt-4"
            icon="i-lucide-save"
            label="Save seat certifications"
            :loading="savingSeats"
            :disabled="!seats.length"
            @click="saveSeats"
          />
        </div>
      </div>
    </UCard>
  </div>
</template>

<script setup lang="ts">
import type { ApiResponse } from '@@/shared/types/api'
import type {
  CbtfAccommodationDto,
  CbtfSeatDto,
  CbtfSeatMapResponse
} from '@@/shared/models/cbtf'
import {
  CBTF_SEAT_PROPERTY_VALUES,
  CBTF_SEAT_PROPERTY_LABELS,
  CBTF_TIME_MULTIPLIER_PRESETS
} from '@@/shared/constants/cbtf'

definePageMeta({ middleware: ['admin-only'] })

const { setTitle } = useAdminPageTitle()
watchEffect(() => setTitle('SSD Accommodations'))

const toast = useToast()

type Tab = 'students' | 'seats'
const tab = ref<Tab>('students')

const seatProperties = CBTF_SEAT_PROPERTY_VALUES.map((value) => ({
  value,
  label: CBTF_SEAT_PROPERTY_LABELS[value]
}))

const multiplierOptions: { label: string; value: number }[] = CBTF_TIME_MULTIPLIER_PRESETS.map(
  (value) => ({
    label: `${value}×`,
    value
  })
)

const { data: accommodations, refresh: refreshAccommodations } =
  useFetch<ApiResponse<CbtfAccommodationDto[]>>('/api/admin/cbtf/accommodations')

const { data: seatMap, refresh: refreshSeats } =
  useFetch<ApiResponse<CbtfSeatMapResponse>>('/api/admin/cbtf/seats')

interface SelectedStudent {
  id: string
  firstName: string
  lastName: string
  email: string
  studentId: string | null
}

const searchEmail = ref('')
const searchError = ref<string | null>(null)
const searching = ref(false)
const selectedUser = ref<SelectedStudent | null>(null)
const editingExisting = ref(false)
const saving = ref(false)

const form = reactive<{
  timeMultiplier: number
  requiredSeatProperties: string[]
  notes: string
}>({
  timeMultiplier: 1,
  requiredSeatProperties: [],
  notes: ''
})

const seats = ref<CbtfSeatDto[]>([])
const selectedSeatNumber = ref<number | null>(null)
const savingSeats = ref(false)

watch(
  () => seatMap.value?.data?.seats,
  (value) => {
    seats.value = (value ?? []).map((seat) => ({
      seatNumber: seat.seatNumber,
      properties: [...seat.properties]
    }))
    if (selectedSeatNumber.value === null && seats.value.length > 0) {
      selectedSeatNumber.value = seats.value[0]!.seatNumber
    }
  },
  { immediate: true }
)

const selectedSeat = computed(() =>
  seats.value.find((seat) => seat.seatNumber === selectedSeatNumber.value) ?? null
)

function selectTab(next: Tab) {
  tab.value = next
}

function toggleProperty(list: string[], property: string, checked: boolean | 'indeterminate') {
  const index = list.indexOf(property)
  if (checked === true && index === -1) list.push(property)
  if (checked === false && index !== -1) list.splice(index, 1)
}

function toggleSelectedSeatProperty(property: string, checked: boolean | 'indeterminate') {
  if (!selectedSeat.value) return
  toggleProperty(selectedSeat.value.properties, property, checked)
}

function removeSelectedAccommodation() {
  if (!selectedUser.value) return
  void removeAccommodation(selectedUser.value.id)
}

function resetForm() {
  form.timeMultiplier = 1
  form.requiredSeatProperties = []
  form.notes = ''
  selectedUser.value = null
  editingExisting.value = false
}

async function lookupStudent() {
  searchError.value = null
  const email = searchEmail.value.trim()
  if (!email) return

  searching.value = true
  try {
    const response = await $fetch<ApiResponse<SelectedStudent & { globalRole: string }>>(
      '/api/admin/cbtf/proctors/search',
      { query: { email } }
    )
    const found = response.data
    if (!found) {
      searchError.value = 'Student not found for that email.'
      return
    }
    selectedUser.value = {
      id: found.id,
      firstName: found.firstName,
      lastName: found.lastName,
      email: found.email,
      studentId: found.studentId ?? null
    }
    const existing = accommodations.value?.data?.find((item) => item.userId === found.id)
    if (existing) {
      editingExisting.value = true
      form.timeMultiplier = existing.timeMultiplier
      form.requiredSeatProperties = [...existing.requiredSeatProperties]
      form.notes = existing.notes ?? ''
    } else {
      editingExisting.value = false
      form.timeMultiplier = 1
      form.requiredSeatProperties = []
      form.notes = ''
    }
  } catch (error: any) {
    selectedUser.value = null
    searchError.value =
      error?.data?.statusMessage || error?.statusMessage || 'Student not found for that email.'
  } finally {
    searching.value = false
  }
}

function editAccommodation(item: CbtfAccommodationDto) {
  tab.value = 'students'
  selectedUser.value = {
    id: item.userId,
    firstName: item.studentName.split(' ')[0] || item.studentName,
    lastName: item.studentName.split(' ').slice(1).join(' '),
    email: item.studentEmail,
    studentId: item.studentId
  }
  searchEmail.value = item.studentEmail
  editingExisting.value = true
  form.timeMultiplier = item.timeMultiplier
  form.requiredSeatProperties = [...item.requiredSeatProperties]
  form.notes = item.notes ?? ''
}

async function saveAccommodation() {
  if (!selectedUser.value) return
  saving.value = true
  try {
    await $fetch(`/api/admin/cbtf/accommodations/${selectedUser.value.id}`, {
      method: 'PUT',
      body: {
        timeMultiplier: form.timeMultiplier,
        requiredSeatProperties: form.requiredSeatProperties,
        notes: form.notes || null
      }
    })
    toast.add({ title: 'Accommodation saved', color: 'success' })
    await refreshAccommodations()
    editingExisting.value = true
  } catch (error: any) {
    toast.add({
      title: 'Could not save accommodation',
      description: error?.data?.statusMessage || error?.statusMessage,
      color: 'error'
    })
  } finally {
    saving.value = false
  }
}

async function removeAccommodation(userId: string) {
  if (!confirm('Remove this accommodation? The student will return to standard time and seats.'))
    return
  saving.value = true
  try {
    await $fetch(`/api/admin/cbtf/accommodations/${userId}`, { method: 'DELETE' })
    toast.add({ title: 'Accommodation removed', color: 'success' })
    await refreshAccommodations()
    resetForm()
  } catch (error: any) {
    toast.add({
      title: 'Could not remove accommodation',
      description: error?.data?.statusMessage || error?.statusMessage,
      color: 'error'
    })
  } finally {
    saving.value = false
  }
}

async function saveSeats() {
  const facilityId = seatMap.value?.data?.facilityId
  if (!facilityId) return
  savingSeats.value = true
  try {
    await $fetch('/api/admin/cbtf/seats', {
      method: 'PUT',
      body: {
        facilityId,
        seats: seats.value.map((seat) => ({
          seatNumber: seat.seatNumber,
          properties: seat.properties
        }))
      }
    })
    toast.add({ title: 'Seat certifications saved', color: 'success' })
    await refreshSeats()
  } catch (error: any) {
    toast.add({
      title: 'Could not save seats',
      description: error?.data?.statusMessage || error?.statusMessage,
      color: 'error'
    })
  } finally {
    savingSeats.value = false
  }
}
</script>
