<template>
  <div class="space-y-6">
    <!-- Training Sandbox Mode Banner -->
    <div
      v-if="isTraining"
      data-testid="training-banner"
      class="p-4 rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50/80 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200 shadow-sm space-y-3"
    >
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          <div
            class="p-2 rounded-lg bg-amber-200/60 dark:bg-amber-900/60 text-amber-800 dark:text-amber-300"
          >
            <UIcon name="i-lucide-graduation-cap" class="w-6 h-6" />
          </div>
          <div>
            <div class="flex items-center gap-2">
              <h2 class="text-base font-bold">PROCTOR TRAINING SANDBOX</h2>
              <UBadge color="warning" variant="solid" size="xs"> In-Memory Mode </UBadge>
            </div>
            <p class="text-xs opacity-85">
              Practice ID card scanning, check-ins, early/late overrides, incident notes, and
              checkouts. Zero database writes.
            </p>
          </div>
        </div>

        <div class="flex items-center gap-2">
          <UButton
            data-testid="reset-scenario-btn"
            size="xs"
            color="neutral"
            variant="soft"
            icon="i-lucide-rotate-ccw"
            label="Reset Scenario"
            @click="proctorState.resetScenario && proctorState.resetScenario()"
          />
          <UButton
            size="xs"
            color="neutral"
            variant="solid"
            icon="i-lucide-arrow-left"
            label="Exit Training"
            to="/proctor"
          />
        </div>
      </div>

      <!-- Training Interactive Controls Bar -->
      <div
        class="pt-2 border-t border-amber-200 dark:border-amber-800/80 flex flex-wrap items-center gap-2.5"
      >
        <span
          class="text-xs font-semibold uppercase tracking-wider text-amber-800 dark:text-amber-400"
        >
          Simulation Controls:
        </span>

        <!-- Mismatch Toggle Pill -->
        <UButton
          data-testid="mismatch-toggle-btn"
          size="xs"
          :color="isMismatchNext ? 'error' : 'neutral'"
          :variant="isMismatchNext ? 'solid' : 'soft'"
          icon="i-lucide-user-x"
          :label="
            isMismatchNext
              ? 'Next Scan: MISMATCH ACTIVE'
              : 'Next Scan: Mismatch (Practice Turn-Away)'
          "
          @click="proctorState.toggleMismatchNext && proctorState.toggleMismatchNext()"
        />

        <!-- Advance Queue Pill -->
        <UButton
          data-testid="advance-arrival-btn"
          size="xs"
          color="primary"
          variant="soft"
          icon="i-lucide-step-forward"
          :label="
            activeTargetStudent
              ? `Queued: ${activeTargetStudent.studentName} ⏭️`
              : 'No Arriving Students Left'
          "
          @click="proctorState.advanceArrivalQueue && proctorState.advanceArrivalQueue()"
        />

        <!-- Quick Jump Scenarios (if arriving students exist) -->
        <div
          v-if="arrivingRoster.length"
          class="hidden sm:flex items-center gap-1 pl-2 border-l border-amber-200 dark:border-amber-800/80"
        >
          <span class="text-xs text-amber-800 dark:text-amber-400">Jump:</span>
          <button
            v-for="(student, idx) in arrivingRoster"
            :key="student.id"
            type="button"
            class="px-2 py-0.5 rounded text-xs font-medium cursor-pointer transition-colors"
            :class="[
              activeArrivalIndex === idx
                ? 'bg-amber-200 dark:bg-amber-900/80 text-amber-950 dark:text-amber-100 font-bold'
                : 'bg-amber-100/60 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 hover:bg-amber-200/50'
            ]"
            @click="proctorState.selectArrivalIndex && proctorState.selectArrivalIndex(idx)"
          >
            {{ student.studentName.split(' ')[0] }}
          </button>
        </div>
      </div>
    </div>

    <!-- Top Command Center Header -->
    <div
      class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 shadow-sm"
    >
      <div class="flex items-center gap-3">
        <div
          class="p-3 bg-primary-100 dark:bg-primary-950/50 rounded-lg text-primary-600 dark:text-primary-400"
        >
          <UIcon name="i-lucide-landmark" class="w-6 h-6" />
        </div>
        <div>
          <div class="flex items-center gap-2">
            <h1 class="text-xl font-bold text-neutral-900 dark:text-neutral-100">
              {{ facilityName }}
            </h1>
            <UBadge :color="isOnDuty ? 'success' : 'neutral'" variant="subtle" size="xs">
              {{ isOnDuty ? 'ON DUTY' : 'OFF DUTY' }}
            </UBadge>
            <UBadge v-if="isTraining" color="warning" variant="subtle" size="xs"> TRAINING </UBadge>
          </div>
          <p class="text-xs text-neutral-500 font-mono">
            {{ liveClock }} • {{ totalSeats }} Total Workstations
          </p>
        </div>
      </div>

      <div v-if="!isTraining" class="space-y-1">
        <label for="proctor-facility" class="block text-xs font-semibold">Testing Center</label>
        <select
          id="proctor-facility"
          v-model="selectedFacilityId"
          class="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        >
          <option value="">Select a testing center</option>
          <option v-for="option in facilities" :key="option.id" :value="option.id">
            {{ option.name }}
          </option>
        </select>
        <p v-if="facilitiesError" class="text-xs text-error" role="alert">
          Unable to load testing centers.
        </p>
        <p v-else-if="!facilities.length && facilitiesStatus !== 'success'" class="text-xs" role="status">
          Loading testing centers…
        </p>
        <p v-else-if="!selectedFacilityId" class="text-xs text-neutral-500" role="status">
          {{ facilities.length ? 'Select a testing center to view its live roster.' : 'No testing centers available.' }}
        </p>
      </div>

      <!-- Quick KPI Counters & Duty Toggle -->
      <div class="flex items-center gap-4">
        <div class="hidden md:flex items-center gap-3">
          <div class="px-3 py-1.5 rounded-lg bg-neutral-100 dark:bg-neutral-800 text-center">
            <span class="block text-xs text-neutral-500 font-medium">Seated</span>
            <span class="text-sm font-bold text-neutral-900 dark:text-neutral-100">
              {{ seatedCount }} /
              {{ totalSeats }}
            </span>
          </div>

          <div class="px-3 py-1.5 rounded-lg bg-neutral-100 dark:bg-neutral-800 text-center">
            <span class="block text-xs text-neutral-500 font-medium">Arriving</span>
            <span class="text-sm font-bold text-neutral-900 dark:text-neutral-100">
              {{ arrivingCount }}
            </span>
          </div>

          <div class="px-3 py-1.5 rounded-lg bg-neutral-100 dark:bg-neutral-800 text-center">
            <span class="block text-xs text-neutral-500 font-medium">Departing Soon</span>
            <span class="text-sm font-bold text-neutral-900 dark:text-neutral-100">
              {{ departuresCount }}
            </span>
          </div>

          <div class="px-3 py-1.5 rounded-lg bg-neutral-100 dark:bg-neutral-800 text-center">
            <span class="block text-xs text-neutral-500 font-medium">Spare Seats</span>
            <span class="text-sm font-bold text-neutral-900 dark:text-neutral-100">
              {{ spareSeats }}
            </span>
          </div>

          <div
            class="px-3 py-1.5 rounded-lg text-center"
            :class="
              outOfServiceSeats > 0
                ? 'bg-red-100 dark:bg-red-950/50'
                : 'bg-neutral-100 dark:bg-neutral-800'
            "
          >
            <span
              class="block text-xs font-medium"
              :class="outOfServiceSeats > 0 ? 'text-red-700 dark:text-red-300' : 'text-neutral-500'"
            >
              Out of Service
            </span>
            <span
              class="text-sm font-bold"
              :class="
                outOfServiceSeats > 0
                  ? 'text-red-800 dark:text-red-200'
                  : 'text-neutral-900 dark:text-neutral-100'
              "
            >
              {{ outOfServiceSeats }}
            </span>
          </div>
        </div>

        <UButton
          size="sm"
          color="warning"
          variant="soft"
          icon="i-lucide-file-warning"
          label="Add Incident / Note"
          @click="proctorState.openNoteModal()"
        />

        <UButton
          v-if="!isTraining"
          size="sm"
          color="primary"
          variant="soft"
          icon="i-lucide-graduation-cap"
          label="Training Mode"
          to="/proctor/training"
        />

        <div
          class="flex items-center gap-2 pl-3 border-l border-neutral-200 dark:border-neutral-800"
        >
          <span class="text-xs font-medium text-neutral-600 dark:text-neutral-400">
            Proctor Duty
          </span>
          <USwitch :model-value="isOnDuty" @update:model-value="proctorState.toggleDuty" />
        </div>
      </div>
    </div>

    <!-- Live Feed Connection Error Banner -->
    <UAlert
      v-if="selectedFacilityId && feedError"
      icon="i-lucide-alert-circle"
      color="error"
      variant="subtle"
      title="Live Feed Connection Error"
      :description="
        feedError.data?.message ||
        feedError.message ||
        'Unable to retrieve live testing facility data from server.'
      "
      class="mb-2"
    />

    <UAlert
      v-if="atRiskCount > 0"
      icon="i-lucide-triangle-alert"
      color="warning"
      variant="subtle"
      :title="`${atRiskCount} ${atRiskCount === 1 ? 'student needs' : 'students need'} a new seat`"
      description="Their workstation is out of service. Open the Manage Seats tab to move them to another seat."
      class="mb-2"
    />

    <!-- Last Action Feedback Banner -->
    <div
      v-if="lastAction"
      class="flex items-center justify-between p-3 rounded-lg border text-sm transition-all"
      :class="[
        lastAction.type === 'checkin'
          ? 'bg-green-50 dark:bg-green-950/40 border-green-200 dark:border-green-800 text-green-800 dark:text-green-300'
          : 'bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-300'
      ]"
    >
      <div class="flex items-center gap-2 font-medium">
        <UIcon
          :name="
            lastAction.type === 'checkin'
              ? 'i-lucide-check-circle-2'
              : 'i-lucide-arrow-right-circle'
          "
          class="w-5 h-5 flex-shrink-0"
        />
        <span>{{ lastAction.message }}</span>
      </div>
      <span class="text-xs opacity-75">
        {{
          lastAction.time.toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit'
          })
        }}
      </span>
    </div>

    <!-- Main Two-Column Layout -->
    <div class="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      <!-- Left Column: Card Swipe Station (5 cols) -->
      <div class="lg:col-span-5 space-y-4">
        <BaseCard>
          <div class="space-y-4">
            <div class="flex items-center justify-between">
              <h2
                class="text-base font-bold text-neutral-900 dark:text-neutral-100 flex items-center gap-2"
              >
                <UIcon name="i-lucide-credit-card" class="w-5 h-5 text-primary-500" />
                <span>ID Card Swipe Station</span>
              </h2>
              <UBadge color="primary" variant="subtle" size="xs"> Auto-Focus </UBadge>
            </div>

            <p class="text-xs text-neutral-500">
              Swipe student ID card or manually type ID and press Enter. Supports magnetic stripe
              readers and barcode scanners. In live mode, use this lookup before checking in or out.
            </p>

            <form @submit.prevent="handleSwipeSubmit">
              <div class="relative">
                <UInput
                  ref="swipeInputRef"
                  v-model="rawSwipeInput"
                  placeholder="Swipe card or enter Student ID..."
                  size="lg"
                  autofocus
                  autocomplete="off"
                  class="w-full font-mono text-base"
                  :disabled="lookupLoading"
                />
                <div class="absolute right-2.5 top-2.5">
                  <UButton
                    size="xs"
                    color="primary"
                    variant="soft"
                    type="submit"
                    :loading="lookupLoading"
                    label="Lookup"
                  />
                </div>
              </div>
            </form>

            <div
              v-if="lookupError"
              class="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300"
            >
              {{ lookupError }}
            </div>

            <!-- Student Verification Card -->
            <div
              v-if="lookupResult"
              class="mt-4 p-4 rounded-xl border transition-all space-y-4"
              :class="[
                lookupResult.decision === 'READY_FOR_CHECKIN'
                  ? 'border-green-300 dark:border-green-800 bg-green-50/50 dark:bg-green-950/20'
                  : lookupResult.decision === 'READY_FOR_CHECKOUT'
                    ? 'border-blue-300 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20'
                    : lookupResult.decision === 'EARLY' || lookupResult.decision === 'LATE'
                      ? 'border-amber-300 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20'
                      : 'border-red-300 dark:border-red-800 bg-red-50/50 dark:bg-red-950/20'
              ]"
            >
              <!-- Photo & Student Info -->
              <div class="flex items-start gap-4">
                <div class="relative flex-shrink-0">
                  <img
                    v-if="lookupResult.student?.avatarUrl"
                    :src="lookupResult.student.avatarUrl"
                    alt="Student Photo"
                    class="w-20 h-20 rounded-lg object-cover border border-neutral-300 dark:border-neutral-700 shadow-sm"
                  />
                  <div
                    v-else
                    class="w-20 h-20 rounded-lg bg-neutral-200 dark:bg-neutral-800 flex items-center justify-center border border-neutral-300 dark:border-neutral-700"
                  >
                    <UIcon name="i-lucide-user" class="w-10 h-10 text-neutral-400" />
                  </div>
                </div>

                <div class="flex-1 min-w-0">
                  <div class="flex items-center justify-between">
                    <h3 class="text-base font-bold text-neutral-900 dark:text-neutral-100 truncate">
                      {{ lookupResult.student?.firstName }}
                      {{ lookupResult.student?.lastName }}
                    </h3>
                    <div
                      v-if="lookupResult.reservation?.seatNumber"
                      class="px-2.5 py-1 rounded-md bg-primary-600 text-white font-mono font-bold text-xs shadow-sm"
                    >
                      {{ seatLabel(lookupResult.reservation) }}
                    </div>
                  </div>

                  <p class="text-xs text-neutral-500 font-mono mt-0.5">
                    ID: {{ lookupResult.student?.studentId || '—' }}
                  </p>
                  <p
                    class="text-xs font-semibold text-neutral-700 dark:text-neutral-300 mt-1 truncate"
                  >
                    {{ lookupResult.reservation?.assignmentTitle || 'No Active Assignment' }}
                  </p>
                  <p v-if="lookupResult.reservation?.startTime" class="text-xs text-neutral-500">
                    Slot:
                    {{ formatSlotTime(lookupResult.reservation.startTime) }}
                  </p>
                </div>
              </div>

              <!-- Message Prompt -->
              <div
                class="p-3 rounded-lg text-xs font-medium"
                :class="[
                  lookupResult.decision === 'READY_FOR_CHECKIN'
                    ? 'bg-green-100 dark:bg-green-900/50 text-green-900 dark:text-green-200'
                    : lookupResult.decision === 'READY_FOR_CHECKOUT'
                      ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-900 dark:text-blue-200'
                      : lookupResult.decision === 'EARLY' || lookupResult.decision === 'LATE'
                        ? 'bg-amber-100 dark:bg-amber-900/50 text-amber-900 dark:text-amber-200'
                        : 'bg-red-100 dark:bg-red-900/50 text-red-900 dark:text-red-200'
                ]"
              >
                {{ lookupResult.message }}
              </div>

              <!-- Action Buttons -->
              <div
                class="flex justify-end gap-2 pt-2 border-t border-neutral-200 dark:border-neutral-800"
              >
                <UButton
                  size="sm"
                  color="neutral"
                  variant="ghost"
                  label="Clear"
                  @click="clearAndRefocus"
                />

                <!-- Add Incident Note Action -->
                <UButton
                  v-if="lookupResult.reservation"
                  size="sm"
                  :color="
                    lookupResult.reservation.noteCount || lookupResult.reservation.notes?.length
                      ? 'warning'
                      : 'neutral'
                  "
                  :variant="
                    lookupResult.reservation.noteCount || lookupResult.reservation.notes?.length
                      ? 'solid'
                      : 'soft'
                  "
                  :icon="
                    lookupResult.reservation.noteCount || lookupResult.reservation.notes?.length
                      ? 'i-lucide-file-warning'
                      : 'i-lucide-file-plus-2'
                  "
                  :label="
                    lookupResult.reservation.noteCount || lookupResult.reservation.notes?.length
                      ? `Notes (${lookupResult.reservation.noteCount || lookupResult.reservation.notes.length})`
                      : 'Add Note'
                  "
                  @click="
                    proctorState.openNoteModal({
                      reservationId: lookupResult.reservation.id,
                      seatNumber: lookupResult.reservation.seatNumber,
                      facilityName: lookupResult.reservation.facilityName,
                      studentName:
                        `${lookupResult.student?.firstName} ${lookupResult.student?.lastName}`.trim(),
                      assignmentTitle: lookupResult.reservation.assignmentTitle,
                      notes: lookupResult.reservation.notes
                    })
                  "
                />

                <!-- Check In Action -->
                <UButton
                  v-if="
                    lookupResult.decision === 'READY_FOR_CHECKIN' ||
                    lookupResult.decision === 'LATE'
                  "
                  size="sm"
                  color="success"
                  icon="i-lucide-check-circle"
                  :loading="lookupLoading"
                  :label="
                    lookupResult.decision === 'LATE'
                      ? 'Override & Check In'
                      : 'Confirm Check-In'
                  "
                  @click="handleCheckInConfirm"
                />

                <!-- Check Out Action -->
                <UButton
                  v-if="lookupResult.decision === 'READY_FOR_CHECKOUT'"
                  size="sm"
                  color="primary"
                  icon="i-lucide-log-out"
                  :loading="lookupLoading"
                  label="Confirm Check-Out"
                  @click="handleCheckOutConfirm"
                />
              </div>
            </div>
          </div>
        </BaseCard>
      </div>

      <!-- Right Column: Live Roster & Feeds (7 cols) -->
      <div class="lg:col-span-7 space-y-4">
        <!-- Sub-Navigation Tabs -->
        <div class="flex border-b border-neutral-200 dark:border-neutral-800 gap-6">
          <button
            type="button"
            class="pb-3 text-sm font-semibold transition-colors border-b-2 cursor-pointer flex items-center gap-2"
            :class="[
              activeFeedTab === 'arriving'
                ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                : 'border-transparent text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300'
            ]"
            @click="activeFeedTab = 'arriving'"
          >
            <UIcon name="i-lucide-user-check" class="w-4 h-4" />
            <span>Expected Arrivals</span>
            <span
              class="px-1.5 py-0.5 rounded-full text-xs bg-neutral-100 dark:bg-neutral-800 font-mono"
            >
              {{ arrivingCount }}
            </span>
          </button>

          <button
            type="button"
            class="pb-3 text-sm font-semibold transition-colors border-b-2 cursor-pointer flex items-center gap-2"
            :class="[
              activeFeedTab === 'seated'
                ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                : 'border-transparent text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300'
            ]"
            @click="activeFeedTab = 'seated'"
          >
            <UIcon name="i-lucide-armchair" class="w-4 h-4" />
            <span>Currently Seated</span>
            <span
              class="px-1.5 py-0.5 rounded-full text-xs bg-neutral-100 dark:bg-neutral-800 font-mono"
            >
              {{ seatedCount }}
            </span>
          </button>

          <button
            type="button"
            class="pb-3 text-sm font-semibold transition-colors border-b-2 cursor-pointer flex items-center gap-2"
            :class="[
              activeFeedTab === 'departures'
                ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                : 'border-transparent text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300'
            ]"
            @click="activeFeedTab = 'departures'"
          >
            <UIcon name="i-lucide-clock" class="w-4 h-4" />
            <span>Departures</span>
            <span
              class="px-1.5 py-0.5 rounded-full text-xs bg-neutral-100 dark:bg-neutral-800 font-mono"
            >
              {{ departuresCount }}
            </span>
          </button>

          <button
            v-if="!isTraining"
            type="button"
            class="pb-3 text-sm font-semibold transition-colors border-b-2 cursor-pointer flex items-center gap-2"
            :class="[
              activeFeedTab === 'workstations'
                ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                : 'border-transparent text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300'
            ]"
            @click="activeFeedTab = 'workstations'"
          >
            <UIcon name="i-lucide-wrench" class="w-4 h-4" />
            <span>Manage Seats</span>
            <span
              v-if="atRiskCount > 0"
              class="px-1.5 py-0.5 rounded-full text-xs bg-red-100 dark:bg-red-950/60 text-red-700 dark:text-red-300 font-mono"
            >
              {{ atRiskCount }}
            </span>
          </button>

          <button
            type="button"
            class="pb-3 text-sm font-semibold transition-colors border-b-2 cursor-pointer flex items-center gap-2"
            :class="[
              activeFeedTab === 'reservations'
                ? 'border-primary-500 text-primary-600 dark:text-primary-400'
                : 'border-transparent text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300'
            ]"
            @click="activeFeedTab = 'reservations'"
          >
            <UIcon name="i-lucide-calendar-clock" class="w-4 h-4" />
            <span>All Reservations</span>
          </button>
        </div>

        <p
          v-if="
            activeFeedTab !== 'reservations' &&
            activeFeedTab !== 'workstations' &&
            liveRosterLoading
          "
          class="py-12 text-center text-neutral-500"
          role="status"
        >
          Loading live roster…
        </p>

        <!-- Tab 1: Expected Arrivals -->
        <div v-else-if="liveRosterReady && activeFeedTab === 'arriving'">
          <BaseDataTable
            :data="arrivingRoster"
            :columns="arrivingColumns"
            empty-icon="i-lucide-users"
            empty-text="No arriving students scheduled in this window."
          />
        </div>

        <!-- Tab 2: Currently Seated Roster -->
        <div v-else-if="liveRosterReady && activeFeedTab === 'seated'">
          <BaseDataTable
            :data="seatedRoster"
            :columns="seatedColumns"
            empty-icon="i-lucide-armchair"
            empty-text="No students currently seated."
          />
        </div>

        <!-- Tab 3: Departures Feed -->
        <div v-else-if="liveRosterReady && activeFeedTab === 'departures'">
          <BaseDataTable
            :data="departuresRoster"
            :columns="departureColumns"
            empty-icon="i-lucide-check-check"
            empty-text="No departures pending or recently completed."
          />
        </div>

        <!-- Tab 4: Manage Seats (take a workstation out of / return to service) -->
        <div v-else-if="activeFeedTab === 'workstations'">
          <FeaturesCbtfWorkstationsPanel
            :facility-id="selectedFacilityId || undefined"
            :facilities="facilities"
            :can-manage-spares="false"
            :show-facility-picker="false"
            :show-certification-note="false"
            @changed="proctorState.refreshFeed?.()"
          />
        </div>

        <!-- Tab 5: All Reservations Roster (Read-only with Canvas resync) -->
        <div v-else-if="activeFeedTab === 'reservations'">
          <FeaturesCbtfReservationsTable
            ref="reservationsTable"
            :read-only="true"
            :show-resync-canvas="true"
            endpoint="/api/proctor/reservations"
            :is-training="isTraining"
          />
        </div>
      </div>
    </div>

    <!-- Proctor Incident / Observation Note Modal -->
    <FeaturesProctorNoteModal
      :open="isNoteModalOpen"
      :target="selectedNoteTarget"
      :seated-roster="seatedRoster"
      :training-facility-name="isTraining ? facilityName : undefined"
      @update:open="handleNoteModalUpdate"
      @update:model-value="handleNoteModalUpdate"
      @submit="handleSaveNote"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, h, resolveComponent, watch } from 'vue'
import { DEFAULT_CBTF_TIMEZONE, getLocalTimeParts } from '@@/shared/utils/timezone'
import FeaturesCbtfWorkstationsPanel from '~/components/features/cbtf/CbtfWorkstationsPanel.vue'
import { parseCardSwipe } from '~/utils/cardSwipe'

const props = withDefaults(
  defineProps<{
    isTraining?: boolean
    proctorState: any
  }>(),
  {
    isTraining: false
  }
)

const unwrapState = <T,>(val: any): T => {
  if (val && typeof val === 'object' && 'value' in val) {
    return val.value
  }
  return val
}

const currentFacility = computed(() => unwrapState<any>(props.proctorState.facility))
const facilities = computed(
  () => unwrapState<{ id: string; name: string }[]>(props.proctorState.facilities) ?? []
)
const selectedFacilityId = computed({
  get: () => unwrapState<string>(props.proctorState.selectedFacilityId) ?? '',
  set: (id: string) => {
    props.proctorState.selectedFacilityId.value = id
  }
})
const facilitiesStatus = computed(() => unwrapState<string>(props.proctorState.facilitiesStatus))
const facilitiesError = computed(() => unwrapState(props.proctorState.facilitiesError))
const seatLabel = (reservation: { seatNumber: number; facilityName?: string }) =>
  `${reservation.facilityName || (props.isTraining ? currentFacility.value?.name : null) || 'Testing center unavailable'} · Seat #${reservation.seatNumber}`
const totalSeats = computed(() => currentFacility.value?.totalSeats ?? '—')
const facilityName = computed(() => currentFacility.value?.name || 'Testing Center Console')

const currentCounts = computed(() => unwrapState<any>(props.proctorState.counts))
const seatedRoster = computed(() => {
  const list = unwrapState<any[]>(props.proctorState.seated)
  return Array.isArray(list) ? list : []
})
const arrivingRoster = computed(() => {
  const list = unwrapState<any[]>(props.proctorState.arriving)
  return Array.isArray(list) ? list : []
})
const departuresRoster = computed(() => {
  const list = unwrapState<any[]>(props.proctorState.departures)
  return Array.isArray(list) ? list : []
})

const seatedCount = computed(() => currentCounts.value?.seated ?? seatedRoster.value.length)
const arrivingCount = computed(() => currentCounts.value?.arriving ?? arrivingRoster.value.length)
const departuresCount = computed(
  () => currentCounts.value?.departures ?? departuresRoster.value.length
)
const spareSeats = computed(() => currentFacility.value?.spareSeats ?? 0)
const outOfServiceSeats = computed(() => currentFacility.value?.outOfServiceSeats ?? 0)
const atRiskRoster = computed(() =>
  [...seatedRoster.value, ...arrivingRoster.value].filter(
    (reservation) => reservation.seatOutOfService
  )
)
const atRiskCount = computed(() => atRiskRoster.value.length)

const isOnDuty = computed(() => Boolean(unwrapState(props.proctorState.isOnDuty)))
const isNoteModalOpen = computed(() => Boolean(unwrapState(props.proctorState.isNoteModalOpen)))
const selectedNoteTarget = computed(() => unwrapState<any>(props.proctorState.selectedNoteTarget))

const lastAction = computed(() => unwrapState<any>(props.proctorState.lastAction))
const lookupResult = computed(() => unwrapState<any>(props.proctorState.lookupResult))
const lookupLoading = computed(() => Boolean(unwrapState(props.proctorState.lookupLoading)))
const lookupError = computed(() => unwrapState<string | null>(props.proctorState.lookupError))

const isMismatchNext = computed(() => Boolean(unwrapState(props.proctorState.isMismatchNext)))
const activeTargetStudent = computed(() => unwrapState<any>(props.proctorState.activeTargetStudent))
const activeArrivalIndex = computed(() =>
  unwrapState<number>(props.proctorState.activeArrivalIndex)
)
const feedError = computed(() => unwrapState<any>(props.proctorState.feedError))

const liveRosterReady = computed(
  () => props.isTraining || Boolean(selectedFacilityId.value && unwrapState(props.proctorState.feedReady))
)
const liveRosterLoading = computed(
  () => !liveRosterReady.value && Boolean(selectedFacilityId.value) && !feedError.value
)
const reservationsTable = ref<{ fetchReservations: () => Promise<void> } | null>(null)
watch(lastAction, (action) => {
  if (action) void reservationsTable.value?.fetchReservations()
})

const activeFeedTab = ref('arriving')
const rawSwipeInput = ref('')
const verifiedInputId = ref('')
const swipeInputRef = ref<any>(null)

// Live Digital Clock
const liveClock = ref('')
let clockTimer: any = null

onMounted(() => {
  const updateClock = () => {
    liveClock.value = new Date().toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit'
    })
  }
  updateClock()
  clockTimer = setInterval(updateClock, 1000)
})

onUnmounted(() => {
  if (clockTimer) clearInterval(clockTimer)
})

const clearAndRefocus = () => {
  props.proctorState.clearLookup()
  verifiedInputId.value = ''
  rawSwipeInput.value = ''
  nextTick(() => {
    swipeInputRef.value?.$el?.querySelector('input')?.focus()
  })
}

watch(rawSwipeInput, (input) => {
  if (input) {
    verifiedInputId.value = ''
    props.proctorState.clearLookup()
  }
})

const handleSwipeSubmit = async () => {
  if (!rawSwipeInput.value.trim() || lookupLoading.value) return

  const input = rawSwipeInput.value
  rawSwipeInput.value = ''
  verifiedInputId.value = parseCardSwipe(input)

  await props.proctorState.lookupStudent(input)
}

const handleCheckInConfirm = async () => {
  const result = lookupResult.value

  if (rawSwipeInput.value || lookupLoading.value || !result?.reservation?.id) return

  const studentId = props.isTraining
    ? result.student?.studentId
    : verifiedInputId.value

  if (!props.isTraining && !studentId) return

  try {
    await props.proctorState.confirmCheckIn(result.reservation.id, studentId)
    clearAndRefocus()
  } catch {
    // Keep the verification card available for retry.
  }
}

const handleCheckOutConfirm = async () => {
  const result = lookupResult.value

  if (rawSwipeInput.value || lookupLoading.value || !result?.reservation?.id) return

  const studentId = props.isTraining
    ? result.student?.studentId
    : verifiedInputId.value

  if (!props.isTraining && !studentId) return

  try {
    await props.proctorState.confirmCheckOut(result.reservation.id, studentId)
    clearAndRefocus()
  } catch {
    // Keep the verification card available for retry.
  }
}

const handleNoteModalUpdate = (val: boolean) => {
  if (!val) {
    props.proctorState.closeNoteModal?.()
  }
}

const handleSaveNote = async (payload: {
  reservationId: string
  content: string
  hasPhotos: boolean
}) => {
  await props.proctorState.addNote(payload)
}

const formatSlotTime = (dateStr: string) => {
  const d = new Date(dateStr)
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

const rosterDateFormatter = computed(() => {
  const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', timeZoneName: 'short' }
  try {
    return new Intl.DateTimeFormat('en-US', {
      ...options,
      timeZone: currentFacility.value?.timezone || DEFAULT_CBTF_TIMEZONE
    })
  } catch {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: DEFAULT_CBTF_TIMEZONE })
  }
})

const formatRosterTime = (value?: string | null) => {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'

  const formatter = rosterDateFormatter.value
  const { timeZone } = formatter.resolvedOptions()
  const parts = formatter.formatToParts(date)
  const month = parts.find((part) => part.type === 'month')?.value
  const day = parts.find((part) => part.type === 'day')?.value
  const zone = parts.find((part) => part.type === 'timeZoneName')?.value
  const { formattedTime } = getLocalTimeParts(date, timeZone)
  return `${month} ${day}, ${formattedTime}${zone ? ` ${zone}` : ''}`
}

const studentColumn = {
  accessorKey: 'studentName',
  header: 'Student',
  cell: ({ row }: { row: any }) =>
    h('div', { class: 'flex flex-col' }, [
      h('span', { class: 'font-semibold' }, row.original.studentName || '—'),
      row.original.studentId &&
        h('span', { class: 'text-xs text-neutral-500 font-mono' }, `ID: ${row.original.studentId}`)
    ])
}

const assignmentColumn = {
  accessorKey: 'assignmentTitle',
  header: 'Assignment',
  cell: ({ row }: { row: any }) => row.original.assignmentTitle || '—'
}

const departureBadges = {
  ENDING_SOON: { label: 'Ending Soon', color: 'warning' },
  OVERDUE: { label: 'Overdue', color: 'error' },
  CHECKED_OUT: { label: 'Checked Out', color: 'neutral' }
} as const

// Columns: Currently Seated
const seatedColumns: any[] = [
  {
    accessorKey: 'seatNumber',
    header: 'Seat',
    cell: ({ row }: { row: any }) =>
      h(
        'span',
        {
          class:
            'px-2 py-1 rounded bg-primary-100 dark:bg-primary-950/60 font-mono font-bold text-primary-700 dark:text-primary-300'
        },
        seatLabel(row.original)
      )
  },
  studentColumn,
  assignmentColumn,
  {
    id: 'examTime',
    header: 'Exam Time',
    cell: ({ row }: { row: any }) =>
      `${formatRosterTime(row.original.startTime)} – ${formatRosterTime(row.original.endTime)}`
  },
  {
    accessorKey: 'remainingMinutes',
    header: 'Time Left',
    cell: ({ row }: { row: any }) => {
      const remaining = row.original.remainingMinutes ?? 0
      const isUrgent = remaining <= 10
      return h(
        'span',
        {
          class: [
            'font-mono font-semibold text-xs px-2 py-0.5 rounded-full',
            isUrgent
              ? 'bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-200 animate-pulse'
              : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300'
          ]
        },
        `${remaining} min`
      )
    }
  },
  {
    id: 'actions',
    header: 'Action',
    cell: ({ row }: { row: any }) =>
      h('div', { class: 'flex items-center gap-1.5' }, [
        h(resolveComponent('UButton'), {
          size: 'xs',
          color: row.original.noteCount ? 'warning' : 'neutral',
          variant: row.original.noteCount ? 'solid' : 'ghost',
          icon: row.original.noteCount ? 'i-lucide-file-warning' : 'i-lucide-file-plus-2',
          label: row.original.noteCount ? `Notes (${row.original.noteCount})` : 'Note',
          title: 'Add or view notes for this student',
          onClick: () =>
            props.proctorState.openNoteModal({
              reservationId: row.original.id,
              seatNumber: row.original.seatNumber,
              facilityName: row.original.facilityName,
              studentName: row.original.studentName,
              assignmentTitle: row.original.assignmentTitle,
              notes: row.original.notes
            })
        }),
        h(resolveComponent('UButton'), {
          size: 'xs',
          color: 'primary',
          variant: 'soft',
          icon: 'i-lucide-log-out',
          label: 'Check Out',
          disabled: !props.isTraining,
          title: props.isTraining ? 'Skip Scan (Practice)' : 'Scan or enter Student ID first',
          onClick: () => {
            if (props.isTraining) {
              return props.proctorState.confirmCheckOut(row.original.id)
            }
          }
        })
      ])
  }
]

// Columns: Expected Arrivals
const arrivingColumns: any[] = [
  {
    accessorKey: 'seatNumber',
    header: 'Seat',
    cell: ({ row }: { row: any }) =>
      row.original.seatNumber
        ? h(
            'span',
            {
              class:
                'px-2 py-1 rounded bg-primary-100 dark:bg-primary-950/60 font-mono font-bold text-primary-700 dark:text-primary-300'
            },
            seatLabel(row.original)
          )
        : h('span', { class: 'font-mono text-neutral-400' }, '—')
  },
  studentColumn,
  assignmentColumn,
  {
    accessorKey: 'startTime',
    header: 'Scheduled Slot',
    cell: ({ row }: { row: any }) =>
      h(
        'span',
        { class: 'text-xs text-neutral-600 dark:text-neutral-400' },
        formatRosterTime(row.original.startTime)
      )
  },
  {
    id: 'actions',
    header: 'Action',
    cell: ({ row }: { row: any }) =>
      h('div', { class: 'flex items-center gap-1.5' }, [
        h(resolveComponent('UButton'), {
          size: 'xs',
          color: row.original.noteCount ? 'warning' : 'neutral',
          variant: row.original.noteCount ? 'solid' : 'ghost',
          icon: row.original.noteCount ? 'i-lucide-file-warning' : 'i-lucide-file-plus-2',
          label: row.original.noteCount ? `Notes (${row.original.noteCount})` : 'Note',
          title: 'Add or view notes for this student',
          onClick: () =>
            props.proctorState.openNoteModal({
              reservationId: row.original.id,
              seatNumber: row.original.seatNumber,
              facilityName: row.original.facilityName,
              studentName: row.original.studentName,
              assignmentTitle: row.original.assignmentTitle,
              notes: row.original.notes
            })
        }),
        h(resolveComponent('UButton'), {
          size: 'xs',
          color: 'success',
          variant: 'soft',
          icon: 'i-lucide-check',
          label: 'Check In',
          disabled: !props.isTraining,
          title: props.isTraining ? 'Skip Scan (Practice)' : 'Scan or enter Student ID first',
          onClick: () => {
            if (props.isTraining) {
              return props.proctorState.confirmCheckIn(row.original.id)
            }
          }
        })
      ])
  }
]

// Columns: Departures Feed
const departureColumns: any[] = [
  {
    accessorKey: 'seatNumber',
    header: 'Seat',
    cell: ({ row }: { row: any }) =>
      row.original.seatNumber
        ? h(
            'span',
            {
              class:
                'px-2 py-1 rounded bg-primary-100 dark:bg-primary-950/60 font-mono font-bold text-primary-700 dark:text-primary-300'
            },
            seatLabel(row.original)
          )
        : h('span', { class: 'font-mono text-neutral-400' }, '—')
  },
  studentColumn,
  assignmentColumn,
  {
    accessorKey: 'endTime',
    header: 'Scheduled End',
    cell: ({ row }: { row: any }) => formatRosterTime(row.original.endTime)
  },
  {
    accessorKey: 'checkedOutAt',
    header: 'Checked Out At',
    cell: ({ row }: { row: any }) => formatRosterTime(row.original.checkedOutAt)
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }: { row: any }) => {
      const status = (row.original.departureStatus ??
        (row.original.status === 'CHECKED_OUT' ? 'CHECKED_OUT' : 'ENDING_SOON')) as keyof typeof departureBadges
      const badge = departureBadges[status]
      return h(resolveComponent('UBadge'), { size: 'xs', variant: 'subtle', color: badge.color }, () => badge.label)
    }
  },
  {
    id: 'actions',
    header: 'Action',
    cell: ({ row }: { row: any }) =>
      h('div', { class: 'flex items-center gap-1.5' }, [
        h(resolveComponent('UButton'), {
          size: 'xs',
          color: row.original.noteCount ? 'warning' : 'neutral',
          variant: row.original.noteCount ? 'solid' : 'ghost',
          icon: row.original.noteCount ? 'i-lucide-file-warning' : 'i-lucide-file-plus-2',
          label: row.original.noteCount ? `Notes (${row.original.noteCount})` : 'Note',
          title: 'Add or view notes for this student',
          onClick: () =>
            props.proctorState.openNoteModal({
              reservationId: row.original.id,
              seatNumber: row.original.seatNumber,
              facilityName: row.original.facilityName,
              studentName: row.original.studentName,
              assignmentTitle: row.original.assignmentTitle,
              notes: row.original.notes
            })
        })
      ])
  }
]

</script>
