import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { useCbtfWorkstations } from '../../../../app/composables/features/admin/useCbtfWorkstations'

const toastAdd = vi.fn()
vi.stubGlobal('useToast', () => ({ add: toastAdd }))

const mockFetch = vi.fn()
vi.stubGlobal('$fetch', mockFetch)

function makeSummary(overrides: any = {}) {
  return {
    facilityId: 'fac-1',
    facilityName: 'Room',
    totalSeats: 20,
    spareSeatCount: 2,
    spareSeatNumbers: [19, 20],
    reassignThresholdMinutes: 60,
    counts: {
      total: 20,
      working: 20,
      available: 18,
      spare: 2,
      spareAvailable: 2,
      outOfService: 0
    },
    seats: Array.from({ length: 20 }, (_, index) => ({
      seatNumber: index + 1,
      state: index >= 18 ? 'SPARE' : 'IN_SERVICE',
      reason: null,
      disabledAt: null
    })),
    atRisk: [],
    ...overrides
  }
}

describe('useCbtfWorkstations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads facilities and the selected facility summary', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === '/api/admin/cbtf/facility') {
        return { statusCode: 200, data: [{ id: 'fac-1', name: 'Room' }] }
      }
      if (url === '/api/cbtf/workstations') {
        return { statusCode: 200, data: makeSummary() }
      }
      throw new Error(`Unexpected request: ${url}`)
    })

    const composable = useCbtfWorkstations()
    await composable.loadFacilities()
    await flushPromises()

    expect(composable.facilities.value).toHaveLength(1)
    expect(composable.selectedFacilityId.value).toBe('fac-1')
    expect(composable.summary.value?.facilityId).toBe('fac-1')
    expect(mockFetch).toHaveBeenCalledWith('/api/cbtf/workstations', {
      query: { facilityId: 'fac-1' }
    })
  })

  it('takes a seat out of service and updates the summary', async () => {
    mockFetch.mockImplementation(async (url: string, options: any) => {
      if (url === '/api/cbtf/workstations') {
        return { statusCode: 200, data: makeSummary() }
      }
      if (url === '/api/cbtf/workstations/5/out-of-service') {
        expect(options).toMatchObject({
          method: 'POST',
          body: { facilityId: 'fac-1', reason: 'broken' }
        })
        return {
          statusCode: 200,
          data: {
            summary: makeSummary({
              counts: {
                total: 20,
                working: 19,
                available: 17,
                spare: 2,
                spareAvailable: 2,
                outOfService: 1
              }
            }),
            moved: [{ reservationId: 'r1', fromSeat: 5, toSeat: 19 }],
            atRisk: []
          }
        }
      }
      throw new Error(`Unexpected request: ${url}`)
    })

    const composable = useCbtfWorkstations()
    composable.selectedFacilityId.value = 'fac-1'
    await flushPromises()

    const result = await composable.takeOutOfService(5, 'broken')

    expect(result?.moved).toHaveLength(1)
    expect(composable.summary.value?.counts.outOfService).toBe(1)
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Workstation out of service', color: 'success' })
    )
  })

  it('moves a reservation to a spare seat and refreshes the summary', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === '/api/cbtf/workstations') {
        return { statusCode: 200, data: makeSummary() }
      }
      if (url === '/api/proctor/reservations/risk-1/move-seat') {
        return { statusCode: 200, data: { id: 'risk-1' } }
      }
      throw new Error(`Unexpected request: ${url}`)
    })

    const composable = useCbtfWorkstations()
    composable.selectedFacilityId.value = 'fac-1'
    await flushPromises()

    const moved = await composable.moveToSpare('risk-1')

    expect(moved).toBe(true)
    expect(mockFetch).toHaveBeenCalledWith('/api/proctor/reservations/risk-1/move-seat', {
      method: 'POST',
      body: {}
    })
    expect(composable.movingId.value).toBeNull()
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Student moved to a spare seat', color: 'success' })
    )
  })
})
