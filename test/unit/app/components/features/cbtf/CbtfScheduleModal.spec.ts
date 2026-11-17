import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import CbtfScheduleModal from '~/components/features/cbtf/CbtfScheduleModal.vue'
import type { CbtfReservationDto } from '@@/shared/models/cbtf'

// Mock composable
const mockFetchAvailability = vi.fn()
const mockCreateReservation = vi.fn()
const mockRescheduleReservation = vi.fn()
const mockCancelReservation = vi.fn()

vi.mock('~/composables/features/useCbtfStudent', () => ({
  useCbtfStudent: () => ({
    fetchAvailability: mockFetchAvailability,
    createReservation: mockCreateReservation,
    rescheduleReservation: mockRescheduleReservation,
    cancelReservation: mockCancelReservation
  })
}))

describe('CbtfScheduleModal', () => {
  const mockAssignment: any = {
    id: 'asg-cbtf-1',
    title: 'Midterm Exam',
    isSchedulable: true
  }

  const mockExistingReservation: CbtfReservationDto = {
    id: 'res-1',
    userId: 'user-1',
    assignmentId: 'asg-cbtf-1',
    assignmentTitle: 'Midterm Exam',
    startTime: '2026-09-15T14:00:00.000Z',
    endTime: '2026-09-15T15:00:00.000Z',
    seatNumber: 12,
    status: 'SCHEDULED',
    createdAt: '2026-09-10T10:00:00.000Z',
    updatedAt: '2026-09-10T10:00:00.000Z'
  }

  const stubs = {
    UModal: {
      template: '<div><slot name="body" /><slot name="footer" /></div>'
    },
    UIcon: true,
    UBadge: {
      template: '<span><slot /></span>'
    },
    UButton: {
      props: ['label', 'disabled', 'loading'],
      template: '<button :disabled="disabled"><slot />{{ label }}</button>'
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchAvailability.mockResolvedValue({
      blocks: [],
      recommendedDays: [],
      hourlySlots: []
    })
  })

  it.each([false, true])('carries the selected center through review and confirmation (rescheduling: %s)', async (rescheduling) => {
    const blocks = ['North', 'South'].map(name => ({
      id: `${name}:2026-10-01-morning`, facilityId: name, facilityName: `${name} Center`,
      label: 'Thursday Morning', dateLabel: 'Oct 1', timeRangeLabel: '8 AM – 12 PM',
      totalSeats: 48, openSlotsCount: 54, totalSlotsCount: 54, utilizationPercentage: 0
    }))
    mockFetchAvailability.mockResolvedValue({ blocks, recommendedDays: [], hourlySlots: [{
      facilityId: 'South', facilityName: 'South Center', startTime: '2026-10-01T09:00:00Z',
      endTime: '2026-10-01T10:00:00Z', formattedTime: '9:00 AM', hour: 9
    }] })
    const wrapper = mount(CbtfScheduleModal, {
      props: { open: false, assignment: mockAssignment, existingReservation: rescheduling ? mockExistingReservation : null }, global: { stubs }
    })
    await wrapper.setProps({ open: true })
    if (rescheduling) {
      await wrapper.findAll('button').find(b => b.text().includes('Reschedule Exam'))!.trigger('click')
    }
    await flushPromises()
    expect(wrapper.text()).toContain('48-seat testing center')
    expect(wrapper.text()).toContain('Available arrival times')
    expect(wrapper.text()).not.toContain('slots open')
    expect(wrapper.text()).not.toContain('booked')
    expect(wrapper.text()).not.toContain('% full')
    expect(wrapper.text()).not.toContain('54')
    expect(wrapper.text()).toContain('North Center')
    expect(wrapper.text()).toContain('South Center')
    await wrapper.findAll('button').find(b => b.text().includes('South Center'))!.trigger('click')
    await flushPromises()
    expect(mockFetchAvailability).toHaveBeenLastCalledWith(mockAssignment.id, blocks[1]!.id, undefined, rescheduling ? mockExistingReservation.id : undefined)
    const timeButton = wrapper.findAll('button').find(b => b.text().includes('9:00 AM'))!
    expect(timeButton.text()).toContain('South Center')
    await timeButton.trigger('click')
    expect(wrapper.text()).toContain('Testing Center')
    expect(wrapper.text()).toContain('South Center')
    expect(mockCreateReservation).not.toHaveBeenCalled()
    expect(mockRescheduleReservation).not.toHaveBeenCalled()
    const result = { ...mockExistingReservation, facilityId: 'South', seatNumber: 7 }
    mockCreateReservation.mockResolvedValue(result)
    mockRescheduleReservation.mockResolvedValue(result)
    await wrapper.findAll('button').find(b => b.text().includes(rescheduling ? 'Confirm Reschedule' : 'Confirm Reservation'))!.trigger('click')
    await flushPromises()
    expect(rescheduling ? mockRescheduleReservation : mockCreateReservation).toHaveBeenCalledWith(
      rescheduling ? mockExistingReservation.id : mockAssignment.id,
      '2026-10-01T09:00:00Z', 'South'
    )
    expect(wrapper.text()).toContain('Exam Confirmed!')
    expect(wrapper.text()).toContain('South Center')
    expect(wrapper.emitted('reserved')?.[0]).toEqual([result])
  })

  it('renders Mode A: current reservation view when existingReservation is present', () => {
    const wrapper = mount(CbtfScheduleModal, {
      props: {
        open: true,
        assignment: mockAssignment,
        existingReservation: mockExistingReservation
      },
      global: { stubs }
    })

    expect(wrapper.text()).toContain('Current Reservation')
    expect(wrapper.text()).toContain('Workstation Seat #12')
    expect(wrapper.text()).toContain('Reschedule Exam')
    expect(wrapper.text()).toContain('Cancel Reservation')
  })

  it('shows reassurance banner and "Keep Current Reservation" when rescheduling with no open slots', async () => {
    const wrapper = mount(CbtfScheduleModal, {
      props: {
        open: true,
        assignment: mockAssignment,
        existingReservation: mockExistingReservation
      },
      global: { stubs }
    })

    // Click "Reschedule Exam"
    const buttons = wrapper.findAll('button')
    const rescheduleBtn = buttons.find((b) => b.text().includes('Reschedule Exam'))
    expect(rescheduleBtn).toBeDefined()
    await rescheduleBtn!.trigger('click')

    // Expect availability was fetched
    expect(mockFetchAvailability).toHaveBeenCalledWith('asg-cbtf-1', undefined, undefined, 'res-1')

    // Check reassurance banner
    expect(wrapper.text()).toContain('Current Reservation Protected')
    expect(wrapper.text()).toContain('Workstation Seat #12')
    expect(wrapper.text()).toContain('No alternative open slots were found')

    // Check footer button says "Keep Current Reservation"
    expect(wrapper.text()).toContain('Keep Current Reservation')
  })

  it('returns to Mode A without modifying reservation when clicking "Keep Current Reservation"', async () => {
    const wrapper = mount(CbtfScheduleModal, {
      props: {
        open: true,
        assignment: mockAssignment,
        existingReservation: mockExistingReservation
      },
      global: { stubs }
    })

    // Enter rescheduling
    const buttons = wrapper.findAll('button')
    const rescheduleBtn = buttons.find((b) => b.text().includes('Reschedule Exam'))
    await rescheduleBtn!.trigger('click')

    // Click "Keep Current Reservation"
    const keepBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('Keep Current Reservation'))
    expect(keepBtn).toBeDefined()
    await keepBtn!.trigger('click')

    // Should return to Mode A
    expect(wrapper.text()).toContain('Current Reservation')
    expect(wrapper.text()).toContain('Workstation Seat #12')
    expect(wrapper.text()).toContain('Reschedule Exam')
    expect(mockRescheduleReservation).not.toHaveBeenCalled()
  })

  it('renders Mode A correctly for CANCELLED reservation with reschedule button and no cancel button', () => {
    const cancelledReservation: CbtfReservationDto = {
      ...mockExistingReservation,
      id: 'res-cancelled',
      status: 'CANCELLED'
    }

    const wrapper = mount(CbtfScheduleModal, {
      props: {
        open: true,
        assignment: mockAssignment,
        existingReservation: cancelledReservation
      },
      global: { stubs }
    })

    expect(wrapper.text()).toContain('Current Reservation')
    expect(wrapper.text()).toContain('This reservation was cancelled')
    expect(wrapper.text()).toContain('Reschedule Exam')
    expect(wrapper.text()).not.toContain('Cancel Reservation')
  })
})
