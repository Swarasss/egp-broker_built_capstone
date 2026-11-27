import type { ApiResponse } from '@@/shared/types/api'
import type { CbtfFacilitySummary, CbtfWorkstationSummary } from '@@/shared/models/cbtf'

export interface WorkstationMutationResult {
  summary: CbtfWorkstationSummary
  moved: Array<{ reservationId: string; fromSeat: number; toSeat: number }>
  atRisk: CbtfWorkstationSummary['atRisk']
}

/**
 * Admin/proctor data + actions for CBTF workstations (in service, spare,
 * out of service) and moving reservations to spare seats.
 */
export function useCbtfWorkstations() {
  const toast = useToast()

  const facilities = ref<CbtfFacilitySummary[]>([])
  const selectedFacilityId = ref<string | undefined>()
  const summary = ref<CbtfWorkstationSummary | null>(null)
  const loading = ref(false)
  const actionLoading = ref(false)
  const spareLoading = ref(false)
  const movingId = ref<string | null>(null)

  const facilityOptions = computed(() =>
    facilities.value.map((facility) => ({ label: facility.name, value: facility.id }))
  )

  async function loadFacilities() {
    try {
      const response =
        await $fetch<ApiResponse<CbtfFacilitySummary[]>>('/api/admin/cbtf/facility')
      facilities.value = response.data ?? []
      if (!facilities.value.some((facility) => facility.id === selectedFacilityId.value)) {
        selectedFacilityId.value = facilities.value[0]?.id
      }
    } catch (error: any) {
      toast.add({
        title: 'Could not load testing facilities',
        description: error?.data?.statusMessage || error?.statusMessage,
        color: 'error'
      })
    }
  }

  async function loadSummary() {
    if (!selectedFacilityId.value) {
      summary.value = null
      return
    }
    loading.value = true
    try {
      const response = await $fetch<ApiResponse<CbtfWorkstationSummary>>(
        '/api/cbtf/workstations',
        { query: { facilityId: selectedFacilityId.value } }
      )
      summary.value = response.data ?? null
    } catch (error: any) {
      summary.value = null
      toast.add({
        title: 'Could not load workstations',
        description: error?.data?.statusMessage || error?.statusMessage,
        color: 'error'
      })
    } finally {
      loading.value = false
    }
  }

  watch(selectedFacilityId, () => void loadSummary(), { immediate: true })

  async function takeOutOfService(seatNumber: number, reason?: string) {
    if (!selectedFacilityId.value) return null
    actionLoading.value = true
    try {
      const response = await $fetch<ApiResponse<WorkstationMutationResult>>(
        `/api/cbtf/workstations/${seatNumber}/out-of-service`,
        {
          method: 'POST',
          body: { facilityId: selectedFacilityId.value, reason }
        }
      )
      if (response.data?.summary) summary.value = response.data.summary
      const moved = response.data?.moved.length ?? 0
      const atRisk = response.data?.atRisk.length ?? 0
      toast.add({
        title: 'Workstation out of service',
        description: moved
          ? `${moved} student${moved === 1 ? '' : 's'} moved to a spare seat.`
          : atRisk
            ? `${atRisk} reservation${atRisk === 1 ? '' : 's'} still need attention.`
            : undefined,
        color: 'success'
      })
      return response.data ?? null
    } catch (error: any) {
      toast.add({
        title: 'Could not take workstation out of service',
        description: error?.data?.statusMessage || error?.statusMessage,
        color: 'error'
      })
      return null
    } finally {
      actionLoading.value = false
    }
  }

  async function returnToService(seatNumber: number) {
    if (!selectedFacilityId.value) return null
    actionLoading.value = true
    try {
      const response = await $fetch<ApiResponse<WorkstationMutationResult>>(
        `/api/cbtf/workstations/${seatNumber}/return-to-service`,
        {
          method: 'POST',
          body: { facilityId: selectedFacilityId.value }
        }
      )
      if (response.data?.summary) summary.value = response.data.summary
      toast.add({ title: 'Workstation returned to service', color: 'success' })
      return response.data ?? null
    } catch (error: any) {
      toast.add({
        title: 'Could not return workstation to service',
        description: error?.data?.statusMessage || error?.statusMessage,
        color: 'error'
      })
      return null
    } finally {
      actionLoading.value = false
    }
  }

  async function saveSpareSeats(spareSeatCount: number) {
    if (!selectedFacilityId.value) return null
    spareLoading.value = true
    try {
      const response = await $fetch<ApiResponse<{ summary: CbtfWorkstationSummary }>>(
        '/api/admin/cbtf/workstations/spares',
        {
          method: 'PATCH',
          body: { facilityId: selectedFacilityId.value, spareSeatCount }
        }
      )
      if (response.data?.summary) summary.value = response.data.summary
      toast.add({ title: 'Spare seats updated', color: 'success' })
      return response.data ?? null
    } catch (error: any) {
      toast.add({
        title: 'Could not update spare seats',
        description: error?.data?.statusMessage || error?.statusMessage,
        color: 'error'
      })
      return null
    } finally {
      spareLoading.value = false
    }
  }

  async function resetSpareSeats() {
    if (!selectedFacilityId.value) return null
    spareLoading.value = true
    try {
      const response = await $fetch<ApiResponse<{ summary: CbtfWorkstationSummary }>>(
        '/api/admin/cbtf/workstations/spares',
        {
          method: 'PATCH',
          body: { facilityId: selectedFacilityId.value, reset: true }
        }
      )
      if (response.data?.summary) summary.value = response.data.summary
      toast.add({ title: 'Spare seats reset', color: 'success' })
      return response.data ?? null
    } catch (error: any) {
      toast.add({
        title: 'Could not reset spare seats',
        description: error?.data?.statusMessage || error?.statusMessage,
        color: 'error'
      })
      return null
    } finally {
      spareLoading.value = false
    }
  }

  async function moveToSpare(reservationId: string) {
    movingId.value = reservationId
    try {
      await $fetch(`/api/proctor/reservations/${reservationId}/move-seat`, {
        method: 'POST',
        body: {}
      })
      toast.add({ title: 'Student moved to a spare seat', color: 'success' })
      await loadSummary()
      return true
    } catch (error: any) {
      toast.add({
        title: 'Could not move student to a spare seat',
        description: error?.data?.statusMessage || error?.statusMessage,
        color: 'error'
      })
      return false
    } finally {
      movingId.value = null
    }
  }

  return {
    facilities,
    facilityOptions,
    selectedFacilityId,
    summary,
    loading,
    actionLoading,
    spareLoading,
    movingId,
    loadFacilities,
    loadSummary,
    takeOutOfService,
    returnToService,
    saveSpareSeats,
    resetSpareSeats,
    moveToSpare
  }
}
