import type { ApiResponse } from '@@/shared/types/api'
import type { CbtfReservationDto } from '@@/shared/models/cbtf'

export function useCbtfAdmin() {
  const toast = useToast()

  const {
    data: facilityData,
    status: facilityStatus,
    refresh: refreshFacility
  } = useFetch<ApiResponse<any[]>>('/api/admin/cbtf/facility')

  const {
    data: shiftsData,
    status: shiftsStatus,
    refresh: refreshShifts
  } = useFetch<ApiResponse<any[]>>('/api/admin/cbtf/shifts')

  const {
    data: reservationsData,
    status: reservationsStatus,
    refresh: refreshReservations
  } = useFetch<ApiResponse<CbtfReservationDto[]>>('/api/admin/cbtf/reservations')

  const {
    data: proctorsData,
    status: proctorsStatus,
    refresh: refreshProctors
  } = useFetch<ApiResponse<any[]>>('/api/admin/cbtf/proctors')

  const selectedFacilityId = ref<string | undefined>()
  const facilities = computed(() => facilityData.value?.data || [])
  watch(
    facilities,
    (items) => {
      if (!items.some((item) => item.id === selectedFacilityId.value)) {
        selectedFacilityId.value = items[0]?.id
      }
    },
    { immediate: true }
  )
  const facility = computed(() =>
    facilities.value.find((item) => item.id === selectedFacilityId.value)
  )
  const shifts = computed(() => shiftsData.value?.data || [])
  const reservations = computed(() => reservationsData.value?.data || [])
  const proctors = computed(() => proctorsData.value?.data || [])

  const saveFacility = async (payload: {
    name?: string
    totalSeats?: number
    seatAllocationOrder?: number[]
    checkInLeadMinutes?: number
    checkInGraceMinutes?: number
    timezone?: string
  }, creating = false) => {
    const facilityId = selectedFacilityId.value
    if (!creating && !facilityId) return
    try {
      const response = await $fetch<ApiResponse<any>>('/api/admin/cbtf/facility', {
        method: creating ? 'POST' : 'PATCH',
        body: creating ? payload : { ...payload, facilityId }
      })
      selectedFacilityId.value = response.data.id
      toast.add({
        title: 'Facility Settings Saved',
        color: 'success'
      })
      await refreshFacility()
    } catch (err: any) {
      toast.add({
        title: 'Failed to Save Facility',
        description: err.data?.message || err.message,
        color: 'error'
      })
      throw err
    }
  }

  const deleteFacility = async () => {
    const id = selectedFacilityId.value
    if (!id) return
    try {
      await $fetch(`/api/admin/cbtf/facility/${id}`, { method: 'DELETE' })
      await refreshFacility()
      toast.add({ title: 'Facility Deleted', color: 'success' })
    } catch (err: any) {
      toast.add({
        title: 'Failed to Delete Facility',
        description: err.data?.statusMessage || err.data?.message || err.message,
        color: 'error'
      })
      throw err
    }
  }

  const upsertOperatingHours = async (dayOfWeek: number, openTime: string, closeTime: string) => {
    if (!facility.value?.id) return
    try {
      await $fetch('/api/admin/cbtf/operating-hours', {
        method: 'POST',
        body: {
          facilityId: facility.value.id,
          dayOfWeek,
          openTime,
          closeTime
        }
      })
      toast.add({
        title: 'Operating Hours Updated',
        color: 'success'
      })
      await refreshFacility()
    } catch (err: any) {
      toast.add({
        title: 'Failed to Update Hours',
        description: err.data?.message || err.message,
        color: 'error'
      })
      throw err
    }
  }

  const deleteOperatingHours = async (id: string) => {
    try {
      await $fetch(`/api/admin/cbtf/operating-hours/${id}`, {
        method: 'DELETE'
      })
      toast.add({
        title: 'Operating Hours Deleted',
        color: 'info'
      })
      await refreshFacility()
    } catch (err: any) {
      toast.add({
        title: 'Failed to Delete Hours',
        description: err.data?.message || err.message,
        color: 'error'
      })
      throw err
    }
  }

  const createException = async (payload: {
    date: string
    isClosed: boolean
    openTime?: string | null
    closeTime?: string | null
    reason?: string | null
  }) => {
    if (!facility.value?.id) return
    try {
      await $fetch('/api/admin/cbtf/exceptions', {
        method: 'POST',
        body: {
          facilityId: facility.value.id,
          ...payload
        }
      })
      toast.add({
        title: 'Schedule Exception Created',
        color: 'success'
      })
      await refreshFacility()
    } catch (err: any) {
      toast.add({
        title: 'Failed to Create Exception',
        description: err.data?.message || err.message,
        color: 'error'
      })
      throw err
    }
  }

  const deleteException = async (id: string) => {
    try {
      await $fetch(`/api/admin/cbtf/exceptions/${id}`, {
        method: 'DELETE'
      })
      toast.add({
        title: 'Exception Deleted',
        color: 'info'
      })
      await refreshFacility()
    } catch (err: any) {
      toast.add({
        title: 'Failed to Delete Exception',
        description: err.data?.message || err.message,
        color: 'error'
      })
      throw err
    }
  }

  const createShift = async (payload: { userId: string; startTime: string; endTime: string }) => {
    if (!facility.value?.id) return
    try {
      await $fetch('/api/admin/cbtf/shifts', {
        method: 'POST',
        body: {
          facilityId: facility.value.id,
          ...payload
        }
      })
      toast.add({
        title: 'Proctor Shift Created',
        color: 'success'
      })
      await refreshShifts()
    } catch (err: any) {
      toast.add({
        title: 'Failed to Create Shift',
        description: err.data?.message || err.message,
        color: 'error'
      })
      throw err
    }
  }

  const deleteShift = async (id: string) => {
    try {
      await $fetch(`/api/admin/cbtf/shifts/${id}`, {
        method: 'DELETE'
      })
      toast.add({
        title: 'Shift Deleted',
        color: 'info'
      })
      await refreshShifts()
    } catch (err: any) {
      toast.add({
        title: 'Failed to Delete Shift',
        description: err.data?.message || err.message,
        color: 'error'
      })
      throw err
    }
  }

  const batchGenerateShifts = async (payload: {
    userId: string
    startDate: string
    endDate: string
    shifts: Array<{ dayOfWeek: number; startTime: string; endTime: string }>
  }) => {
    if (!facility.value?.id) return
    try {
      const res = await $fetch<ApiResponse<{ count: number; shifts: any[] }>>(
        '/api/admin/cbtf/shifts/batch',
        {
          method: 'POST',
          body: {
            facilityId: facility.value.id,
            ...payload
          }
        }
      )
      toast.add({
        title: 'Weekly Shifts Generated',
        description: `Successfully scheduled ${res.data?.count || 0} shift instances.`,
        color: 'success'
      })
      await refreshShifts()
      return res.data
    } catch (err: any) {
      toast.add({
        title: 'Failed to Generate Weekly Shifts',
        description: err.data?.statusMessage || err.data?.message || err.message,
        color: 'error'
      })
      throw err
    }
  }

  const updateShift = async (
    id: string,
    payload: { userId?: string; startTime: string; endTime: string }
  ) => {
    try {
      const res = await $fetch<ApiResponse<any>>(`/api/admin/cbtf/shifts/${id}`, {
        method: 'PATCH',
        body: payload
      })
      toast.add({
        title: 'Shift Updated',
        description: 'Successfully updated shift details.',
        color: 'success'
      })
      await refreshShifts()
      return res.data
    } catch (err: any) {
      toast.add({
        title: 'Failed to Update Shift',
        description: err.data?.statusMessage || err.data?.message || err.message,
        color: 'error'
      })
      throw err
    }
  }

  const updateReservation = async (
    id: string,
    updates: { status?: string; seatNumber?: number }
  ) => {
    try {
      await $fetch(`/api/admin/cbtf/reservations/${id}`, {
        method: 'PATCH',
        body: updates
      })
      toast.add({
        title: 'Reservation Updated',
        color: 'success'
      })
      await refreshReservations()
    } catch (err: any) {
      toast.add({
        title: 'Update Failed',
        description: err.data?.message || err.message,
        color: 'error'
      })
      throw err
    }
  }

  const searchUserByEmail = async (email: string) => {
    try {
      const res = await $fetch<ApiResponse<any>>(
        `/api/admin/cbtf/proctors/search?email=${encodeURIComponent(email.trim().toLowerCase())}`
      )
      return res.data
    } catch (err: any) {
      const msg =
        err.data?.message || err.data?.statusMessage || err.message || 'Failed to search user'
      toast.add({
        title: 'User Search Failed',
        description: msg,
        color: 'error'
      })
      throw err
    }
  }

  const grantProctorRole = async (userId: string) => {
    try {
      const res = await $fetch<ApiResponse<any>>('/api/admin/cbtf/proctors', {
        method: 'POST',
        body: { userId }
      })
      toast.add({
        title: 'Proctor Role Granted',
        description:
          `Successfully granted proctor role to ${res.data?.firstName || ''} ${res.data?.lastName || ''}`.trim(),
        color: 'success'
      })
      await refreshProctors()
      return res.data
    } catch (err: any) {
      toast.add({
        title: 'Failed to Grant Proctor Role',
        description: err.data?.message || err.data?.statusMessage || err.message,
        color: 'error'
      })
      throw err
    }
  }

  return {
    facilities,
    selectedFacilityId,
    deleteFacility,
    facility,
    facilityStatus,
    refreshFacility,
    shifts,
    shiftsStatus,
    refreshShifts,
    reservations,
    reservationsStatus,
    refreshReservations,
    proctors,
    proctorsStatus,
    refreshProctors,
    searchUserByEmail,
    grantProctorRole,
    saveFacility,
    upsertOperatingHours,
    deleteOperatingHours,
    createException,
    deleteException,
    createShift,
    deleteShift,
    batchGenerateShifts,
    updateShift,
    updateReservation
  }
}
