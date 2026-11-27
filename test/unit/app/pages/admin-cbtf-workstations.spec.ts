import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import CbtfWorkstationsPage from '~/pages/admin/cbtf-workstations.vue'

const toastAdd = vi.fn()
vi.stubGlobal('useToast', () => ({ add: toastAdd }))
vi.stubGlobal('useAdminPageTitle', () => ({ setTitle: vi.fn() }))
vi.stubGlobal('useSeo', vi.fn())
vi.stubGlobal('definePageMeta', vi.fn())

const mockFetch = vi.fn()
vi.stubGlobal('$fetch', mockFetch)

function makeSummary() {
  return {
    facilityId: 'fac-1',
    facilityName: 'Room',
    totalSeats: 20,
    spareSeatCount: 2,
    spareSeatNumbers: [19, 20],
    reassignThresholdMinutes: 60,
    counts: {
      total: 20,
      working: 19,
      available: 17,
      spare: 2,
      spareAvailable: 1,
      outOfService: 1
    },
    seats: Array.from({ length: 20 }, (_, index) => {
      const seatNumber = index + 1
      const state =
        seatNumber === 5 ? 'OUT_OF_SERVICE' : seatNumber >= 19 ? 'SPARE' : 'IN_SERVICE'
      return {
        seatNumber,
        state,
        reason: seatNumber === 5 ? 'Monitor broken' : null,
        disabledAt: seatNumber === 5 ? '2030-01-01T09:00:00.000Z' : null
      }
    }),
    atRisk: [
      {
        reservationId: 'risk-1',
        seatNumber: 5,
        userId: 'u1',
        studentName: 'Ada Student',
        assignmentTitle: 'Exam',
        startTime: '2030-01-01T11:00:00.000Z',
        endTime: '2030-01-01T12:00:00.000Z',
        status: 'SCHEDULED'
      }
    ]
  }
}

const stubs = {
  USelect: {
    props: ['modelValue', 'items', 'id'],
    emits: ['update:modelValue'],
    template:
      '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="item in items" :key="item.value" :value="item.value">{{ item.label }}</option></select>'
  },
  UButton: {
    props: ['label', 'loading', 'disabled'],
    emits: ['click'],
    template: '<button :disabled="loading || disabled" @click="$emit(\'click\')">{{ label }}<slot /></button>'
  },
  UInput: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template:
      '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />'
  },
  UTextarea: {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template:
      '<textarea :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />'
  },
  UModal: {
    props: ['open', 'title'],
    template: '<div v-if="open"><slot name="body" /><slot name="footer" /></div>'
  },
  UCard: {
    template: '<div><slot name="header" /><slot /></div>'
  }
}

describe('app/pages/admin/cbtf-workstations.vue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockImplementation(async (url: string) => {
      if (url === '/api/admin/cbtf/facility') {
        return { statusCode: 200, data: [{ id: 'fac-1', name: 'Room' }] }
      }
      if (url === '/api/cbtf/workstations') {
        return { statusCode: 200, data: makeSummary() }
      }
      throw new Error(`Unexpected request: ${url}`)
    })
  })

  async function mountPage() {
    const wrapper = mount(CbtfWorkstationsPage, { global: { stubs } })
    await flushPromises()
    await flushPromises()
    return wrapper
  }

  it('shows capacity counts and accessible seat labels', async () => {
    const wrapper = await mountPage()

    expect(wrapper.text()).toContain('Workstations')
    expect(wrapper.text()).toContain('20 total')
    expect(wrapper.text()).toContain('17 available')
    expect(wrapper.text()).toContain('2 spare')
    expect(wrapper.text()).toContain('1 out of service')

    const brokenSeat = wrapper.find('[aria-label="Seat 5: Out of service"]')
    expect(brokenSeat.exists()).toBe(true)
    expect(wrapper.find('[aria-label="Seat 19: Spare seat"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="Seat 1: In service"]').exists()).toBe(true)
  })

  it('offers return-to-service for an out-of-service seat', async () => {
    const wrapper = await mountPage()

    await wrapper.find('[aria-label="Seat 5: Out of service"]').trigger('click')
    expect(wrapper.text()).toContain('Seat 5 — Out of service')
    expect(wrapper.text()).toContain('Reason: Monitor broken')
    expect(wrapper.text()).toContain('Return to service')
  })

  it('lists at-risk reservations and moves them to a spare seat', async () => {
    const wrapper = await mountPage()

    expect(wrapper.text()).toContain('Reservations at risk')
    expect(wrapper.text()).toContain('Ada Student — Exam')

    const moveButton = wrapper
      .findAll('button')
      .find((button) => button.text().includes('Move to spare'))
    expect(moveButton).toBeDefined()

    mockFetch.mockResolvedValueOnce({ statusCode: 200, data: { id: 'risk-1' } })
    await moveButton!.trigger('click')
    await flushPromises()

    expect(mockFetch).toHaveBeenCalledWith('/api/proctor/reservations/risk-1/move-seat', {
      method: 'POST',
      body: {}
    })
  })
})
