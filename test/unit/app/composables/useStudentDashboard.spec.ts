import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref, resolveComponent } from 'vue'
import { mount } from '@vue/test-utils'
import { useStudentDashboard } from '~/composables/features/useStudentDashboard'

const redemptions = ref<{ data: unknown[] }>({ data: [] })
const pools = ref<{ data: unknown[] }>({ data: [] })
const refresh = vi.fn()
const reservation = ref<{
  id: string
  status: string
  isRetake?: boolean
  missedRecoveryWindow?: { start: string; end: string }
}>({ id: 'completed', status: 'COMPLETED' })

vi.mock('~/composables/features/useCbtfStudent', () => ({
  useCbtfStudent: () => ({
    getReservationForAssignment: () => reservation.value,
    refreshReservations: vi.fn()
  })
}))
vi.mock('~/composables/features/useEnrollmentsFeature', () => ({
  useCurrentEnrollment: () => ({ data: ref(null) })
}))

describe('student dashboard CBTF retake action', () => {
  const assignments = ['exam-a', 'exam-b'].map((id) => ({
    id, title: 'Same title', isSchedulable: true
  }))

  beforeEach(() => {
    reservation.value = { id: 'completed', status: 'COMPLETED' }
    redemptions.value = { data: [] }
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-08T09:00:00Z'))
    vi.stubGlobal('h', h)
    vi.stubGlobal('resolveComponent', resolveComponent)
    vi.stubGlobal('useToast', () => ({ add: vi.fn() }))
    vi.stubGlobal('useFetch', (url: string) => ({
      data: url === '/api/me/redemptions' ? redemptions : url === '/api/me/pass-pools' ? pools : ref(null),
      status: ref('success'),
      refresh
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('offers a retake only for the assignment ID with a currently usable server window', async () => {
    redemptions.value = {
      data: [
        {
          assignmentId: 'exam-a', assignmentTitle: 'Same title',
          cbtfRetakeWindow: { start: '2030-01-08T08:00:00Z', end: '2030-01-08T09:00:01Z', reservationId: null }
        },
        { assignmentId: 'exam-b', assignmentTitle: 'Same title', cbtfRetakeWindow: null }
      ]
    }
    const wrapper = mount(defineComponent({
      setup() {
        const dashboard = useStudentDashboard()
        const column = dashboard.assignmentColumns.find((item) => item.accessorKey === 'cbtfSlot')!
        return () => h('div', [
          ...assignments.map((assignment) => h('div', { id: assignment.id }, [
            column.cell!({ row: { original: assignment } })
          ])),
          h('p', { id: 'selected' }, dashboard.selectedCbtfAssignment.value?.id)
        ])
      }
    }))

    expect(wrapper.get('#exam-a').text()).toContain('Retake available with redeemed pass')
    expect(wrapper.get('#exam-b').find('button').exists()).toBe(false)
    await wrapper.get('#exam-a button').trigger('click')
    expect(wrapper.get('#selected').text()).toBe('exam-a')

    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(wrapper.get('#exam-a').find('button').exists()).toBe(false)
    wrapper.unmount()
  })
  it('offers normal missed recovery until its deadline, then uses only a valid retake action', async () => {
    reservation.value = {
      id: 'missed', status: 'MISSED',
      missedRecoveryWindow: { start: '2030-01-08T08:00:00Z', end: '2030-01-08T09:00:00Z' }
    }
    const receipt = {
      assignmentId: 'exam-a',
      cbtfRetakeWindow: { start: '2030-01-08T08:00:00Z', end: '2030-01-08T10:00:00Z', reservationId: null }
    }
    redemptions.value = { data: [receipt] }

    const wrapper = mount(defineComponent({
      setup() {
        const dashboard = useStudentDashboard()
        const column = dashboard.assignmentColumns.find((item) => item.accessorKey === 'cbtfSlot')!
        return () => h('div', [
          column.cell!({ row: { original: assignments[0] } }),
          h('p', { id: 'selected-reservation' }, dashboard.selectedCbtfReservation.value?.id)
        ])
      }
    }))

    expect(wrapper.get('button').text()).toBe('Missed (Reschedule)')
    await wrapper.get('button').trigger('click')
    expect(wrapper.get('#selected-reservation').text()).toBe('missed')

    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(wrapper.get('button').text()).toBe('Schedule Retake')
    await wrapper.get('button').trigger('click')
    expect(wrapper.get('#selected-reservation').text()).toBe('')

    redemptions.value = { data: [] }
    await nextTick()
    expect(wrapper.find('button').exists()).toBe(false)
    expect(wrapper.text()).toContain('Missed')

    reservation.value = { id: 'missed-retake', status: 'MISSED', isRetake: true }
    redemptions.value = {
      data: [{ ...receipt, cbtfRetakeWindow: { ...receipt.cbtfRetakeWindow, reservationId: 'missed-retake' } }]
    }
    await nextTick()
    expect(wrapper.get('button').text()).toBe('Reschedule Retake')
    await wrapper.get('button').trigger('click')
    expect(wrapper.get('#selected-reservation').text()).toBe('missed-retake')
    wrapper.unmount()
  })

  it('disables redemption while an active receipt blocks it and enables another after consumption', async () => {
    const pass = { id: 'retry', name: 'Exam Retry', hoursPerPass: 24 }
    const assignment = { ...assignments[0], eligiblePassTypes: [pass] }
    const receipt = {
      assignmentId: assignment.id, dueDate: '2030-01-09T09:00:00Z',
      cbtfRetakeRedemptionBlockedUntil: '2030-01-09T09:00:00Z'
    }
    pools.value = { data: [{ ...pass, passTypeId: pass.id, balance: 2 }] }
    redemptions.value = { data: [receipt] }

    const wrapper = mount(defineComponent({
      setup() {
        const dashboard = useStudentDashboard()
        const column = dashboard.assignmentColumns.find((item) => item.accessorKey === 'eligiblePassTypes')!
        return () => h('div', [
          column.cell!({ row: { original: assignment } }),
          h('p', { id: 'confirmation' }, dashboard.showRedemptionModal.value &&
            dashboard.selectedLatestRedemption.value === null ? 'Ready' : '')
        ])
      }
    }))
    expect(wrapper.get('button').attributes()).toHaveProperty('disabled')
    expect(wrapper.get('button').text()).toContain('already redeemed')

    // The receipt's date is still in the future, but the server reports its claim as consumed.
    redemptions.value = { data: [{ ...receipt, cbtfRetakeRedemptionBlockedUntil: null }] }
    await nextTick()
    expect(wrapper.get('button').attributes()).not.toHaveProperty('disabled')
    await wrapper.get('button').trigger('click')
    expect(wrapper.get('#confirmation').text()).toBe('Ready')

    pools.value = { data: [{ ...pass, passTypeId: pass.id, balance: 0 }] }
    await nextTick()
    expect(wrapper.get('button').attributes()).toHaveProperty('disabled')
    wrapper.unmount()
  })

})
