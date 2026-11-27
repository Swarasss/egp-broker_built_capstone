import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick, ref, unref } from 'vue'
import { useCbtfProctor } from '../../../../app/composables/features/proctor/useCbtfProctor'

const mockToast = {
  add: vi.fn()
}
vi.stubGlobal('useToast', () => mockToast)

const mockStatusData = ref({ data: { isOnDuty: false } })
const facilityA = { id: 'fac-1', name: 'Main CBTF', totalSeats: 48 }
const facilityB = { id: 'fac-2', name: 'Facility B', totalSeats: 30 }
const mockFacilities = ref({ data: [facilityA, facilityB] })
let feedQuery: any
const mockFeedData = ref({
  data: {
    facility: {
      id: 'fac-1',
      name: 'Main CBTF',
      totalSeats: 48,
      occupiedSeats: 1,
      availableSeats: 47
    },
    counts: { seated: 1, arriving: 1, departures: 0 },
    seated: [{ id: 'res-1', seatNumber: 10, studentName: 'Alice' }],
    arriving: [{ id: 'res-2', seatNumber: 12, studentName: 'Bob' }],
    departures: []
  }
})

const mockRefreshStatus = vi.fn()
const mockRefreshFeed = vi.fn()

const mockFeedError = ref<any>(null)

vi.stubGlobal('useFetch', (url: string, options?: any) => {
  if (url === '/api/proctor/facilities') {
    return { data: mockFacilities, refresh: vi.fn() }
  }
  if (url === '/api/proctor/status') {
    return {
      data: mockStatusData,
      status: ref('idle'),
      error: ref(null),
      refresh: mockRefreshStatus
    }
  }
  feedQuery = options.query
  return { data: mockFeedData, status: ref('idle'), error: mockFeedError, refresh: mockRefreshFeed }
})

const mockFetch = vi.fn()
vi.stubGlobal('$fetch', mockFetch)

describe('useCbtfProctor Composable', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStatusData.value = { data: { isOnDuty: false } }
    mockFeedError.value = null
    mockFacilities.value = { data: [facilityA, facilityB] }
  })

  it('computes feed rosters and counts and exposes feedError', () => {
    const { seated, arriving, counts, facility, isOnDuty, feedError, selectedFacilityId } =
      useCbtfProctor()
    expect(seated.value).toEqual([])
    selectedFacilityId.value = facilityA.id

    expect(isOnDuty.value).toBe(false)
    expect(facility.value?.name).toBe('Main CBTF')
    expect(counts.value.seated).toBe(1)
    expect(seated.value.length).toBe(1)
    expect(arriving.value.length).toBe(1)
    expect(feedError.value).toBeNull()
  })

  it('moves a reservation to a spare seat and refreshes the feed', async () => {
    const { moveToSpare } = useCbtfProctor()
    mockFetch.mockResolvedValueOnce({ statusCode: 200, data: { id: 'res-1' } })

    await moveToSpare('res-1')

    expect(mockFetch).toHaveBeenCalledWith('/api/proctor/reservations/res-1/move-seat', {
      method: 'POST',
      body: {}
    })
    expect(mockRefreshFeed).toHaveBeenCalled()
    expect(mockToast.add).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Student moved to a spare seat', color: 'success' })
    )
  })

  it('sends the selected ID, hides stale rosters, and clears a removed facility selection', async () => {
    const { facilities, selectedFacilityId, seated } = useCbtfProctor()
    expect(facilities.value).toEqual([facilityA, facilityB])
    expect(unref(feedQuery)).toEqual({ facilityId: undefined })

    selectedFacilityId.value = facilityA.id
    expect(unref(feedQuery)).toEqual({ facilityId: facilityA.id })
    expect(seated.value[0].studentName).toBe('Alice')

    selectedFacilityId.value = facilityB.id
    expect(unref(feedQuery)).toEqual({ facilityId: facilityB.id })
    expect(seated.value).toEqual([])
    const originalFeed = mockFeedData.value
    mockFeedData.value = {
      data: {
        ...originalFeed.data,
        facility: { ...originalFeed.data.facility, ...facilityB },
        seated: [{ id: 'res-b', seatNumber: 10, studentName: 'Bob' }]
      }
    }
    expect(seated.value[0].studentName).toBe('Bob')
    mockFeedData.value = originalFeed

    mockFacilities.value = {
      data: [
        { ...facilityA, name: 'Renamed Facility A' },
        { id: 'fac-3', name: 'Facility C', totalSeats: 36 }
      ]
    }
    await nextTick()
    expect(facilities.value.map((facility) => facility.name)).toEqual([
      'Renamed Facility A',
      'Facility C'
    ])
    expect(selectedFacilityId.value).toBe('')
    expect(seated.value).toEqual([])
  })

  it('toggles duty status', async () => {
    mockFetch.mockResolvedValueOnce({ statusCode: 200, data: { isOnDuty: true } })
    const { toggleDuty } = useCbtfProctor()

    await toggleDuty(true)

    expect(mockFetch).toHaveBeenCalledWith('/api/proctor/status', {
      method: 'PATCH',
      body: { isOnDuty: true }
    })
    expect(mockRefreshStatus).toHaveBeenCalled()
    expect(mockToast.add).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Checked On Duty', color: 'success' })
    )
  })

  it('looks up student with card swipe parsing', async () => {
    const mockLookup = {
      found: true,
      student: { firstName: 'Alice', lastName: 'A', studentId: '906000001' },
      reservation: { seatNumber: 10 },
      decision: 'READY_FOR_CHECKIN'
    }
    mockFetch.mockResolvedValueOnce({ data: mockLookup })

    const { lookupStudent, lookupResult } = useCbtfProctor()

    // Pass a raw track 2 card swipe
    const result = await lookupStudent(';906000001=2812?')

    expect(mockFetch).toHaveBeenCalledWith('/api/proctor/lookup', {
      params: { studentId: '906000001' }
    })
    expect(result).toEqual(mockLookup)
    expect(lookupResult.value).toEqual(mockLookup)
  })

  it('confirms check-in and updates lastAction and feed', async () => {
    mockFetch.mockResolvedValueOnce({
      data: {
        id: 'res-1',
        studentName: 'Alice',
        seatNumber: 10,
        facilityName: 'Facility A',
        status: 'CHECKED_IN'
      }
    })

    const { confirmCheckIn, lastAction, lookupResult } = useCbtfProctor()
    lookupResult.value = { reservation: { id: 'res-1' } }

    const result = await confirmCheckIn('res-1')

    expect(mockFetch).toHaveBeenCalledWith('/api/proctor/check-in', {
      method: 'POST',
      body: { reservationId: 'res-1' }
    })
    expect(result.status).toBe('CHECKED_IN')
    expect(lastAction.value?.type).toBe('checkin')
    expect(lastAction.value?.message).toContain('Facility A · Seat #10')
    expect(mockToast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Direct to Facility A · Seat #10. RETAIN student ID.'
      })
    )
    expect(lookupResult.value).toBeNull()
    expect(mockRefreshFeed).toHaveBeenCalled()
  })

  it('confirms check-out and updates lastAction and feed', async () => {
    mockFetch.mockResolvedValueOnce({
      data: { id: 'res-1', studentName: 'Alice', seatNumber: 10, status: 'CHECKED_OUT' }
    })

    const { confirmCheckOut, lastAction, lookupResult } = useCbtfProctor()
    lookupResult.value = { reservation: { id: 'res-1' } }

    const result = await confirmCheckOut('res-1')

    expect(mockFetch).toHaveBeenCalledWith('/api/proctor/check-out', {
      method: 'POST',
      body: { reservationId: 'res-1' }
    })
    expect(result.status).toBe('CHECKED_OUT')
    expect(lastAction.value?.type).toBe('checkout')
    expect(lastAction.value?.message).toContain('RETURN student ID')
    expect(lookupResult.value).toBeNull()
    expect(mockRefreshFeed).toHaveBeenCalled()
  })

  it('manages note modal open/close and records incident note', async () => {
    mockFetch.mockResolvedValueOnce({
      data: { id: 'note-1', seatNumber: 12, studentName: 'Bob' }
    })

    const { isNoteModalOpen, selectedNoteTarget, openNoteModal, closeNoteModal, addNote } =
      useCbtfProctor()

    expect(isNoteModalOpen.value).toBe(false)
    expect(selectedNoteTarget.value).toBeNull()

    openNoteModal({ seatNumber: 12, studentName: 'Bob' })
    expect(isNoteModalOpen.value).toBe(true)
    expect(selectedNoteTarget.value?.seatNumber).toBe(12)

    await addNote({ reservationId: 'res-2', content: 'Glancing at neighbor', hasPhotos: true })

    expect(mockFetch).toHaveBeenCalledWith('/api/proctor/notes', {
      method: 'POST',
      body: { reservationId: 'res-2', content: 'Glancing at neighbor', hasPhotos: true }
    })
    expect(mockToast.add).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Incident Note Logged', color: 'warning' })
    )
    expect(isNoteModalOpen.value).toBe(false)
    expect(selectedNoteTarget.value).toBeNull()

    // Test explicit closeNoteModal
    openNoteModal({ seatNumber: 5 })
    expect(isNoteModalOpen.value).toBe(true)
    closeNoteModal()
    expect(isNoteModalOpen.value).toBe(false)
  })
})
