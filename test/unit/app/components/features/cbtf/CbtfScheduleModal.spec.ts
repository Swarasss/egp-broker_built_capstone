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
    facilityId: 'fac-1',
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
      hourlySlots: [],
      availabilityStatus: 'NO_AVAILABLE_SEATS'
    })
  })

  it.each([
    ['RESERVATION_NOT_OPEN', 'The reservation window for this exam has not opened yet.'],
    ['RESERVATION_CLOSED', 'The reservation window for this exam is currently closed.'],
    ['RETAKE_PASS_REQUIRED', 'A redeemed retake pass is required to schedule another attempt.'],
    ['RETAKE_WINDOW_EXPIRED', 'Your retake window has expired or the pass was already used for an attempt.'],
    ['NO_CONFIGURED_FACILITY_HOURS', 'No testing center is configured with operating hours that overlap this exam window.'],
    ['NO_AVAILABLE_SEATS', 'No testing-center availability is currently available within your exam window.']
  ])('explains %s and disables Next', async (availabilityStatus, message) => {
    mockFetchAvailability.mockResolvedValue({ availabilityStatus, blocks: [], hourlySlots: [] })
    const wrapper = mount(CbtfScheduleModal, {
      props: { open: false, assignment: mockAssignment }, global: { stubs }
    })
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toBe(message)
    expect(wrapper.findAll('button').find(button => button.text() === 'Next')?.attributes()).toHaveProperty('disabled')
  })

  it('shows both calendar dates for the server-provided retake window', async () => {
    mockFetchAvailability.mockResolvedValue({
      availabilityStatus: 'AVAILABLE',
      studentWindow: {
        isPassWindow: true,
        start: new Date(2030, 10, 30, 14).toISOString(),
        end: new Date(2030, 11, 1, 14).toISOString()
      }
    })
    const wrapper = mount(CbtfScheduleModal, {
      props: { open: true, assignment: mockAssignment }, global: { stubs }
    })
    await flushPromises()
    expect(wrapper.text()).toContain('Retake scheduling window')
    expect(wrapper.text()).toContain('Nov 30')
    expect(wrapper.text()).toContain('Dec 1')
  })

  it.each([
    [{ data: { data: { availabilityStatus: 'INVALID_ASSIGNMENT_WINDOW' } } },
      'This exam is not fully configured for CBTF scheduling. Please contact your instructor.'],
    [new Error('Internal stack trace'), 'Testing-center availability could not be loaded. Please try again.']
  ])('shows a safe request error instead of empty availability', async (error, message) => {
    mockFetchAvailability.mockRejectedValue(error)
    const wrapper = mount(CbtfScheduleModal, {
      props: { open: false, assignment: mockAssignment }, global: { stubs }
    })
    await wrapper.setProps({ open: true })
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toBe(message)
    expect(wrapper.text()).not.toContain('No testing-center availability')
    expect(wrapper.text()).not.toContain('Internal stack trace')
  })

  it.each([false, true])('shows a compact timezone and books only the selected time (rescheduling: %s)', async (rescheduling) => {
    const startTime = '2026-10-01T13:00:00Z'
    mockFetchAvailability.mockResolvedValue({
      availabilityStatus: 'AVAILABLE',
      schedulingChoices: {
        morning: [{
          date: '2026-10-01',
          label: 'Thu, Oct 1',
          times: [{ startTime, endTime: '2026-10-01T14:00:00Z', formattedTime: '9:00 AM', timezone: 'America/New_York' }]
        }],
        afternoon: []
      }
    })
    const wrapper = mount(CbtfScheduleModal, {
      props: { open: false, assignment: mockAssignment, existingReservation: rescheduling ? mockExistingReservation : null },
      global: { stubs }
    })
    const button = (text: string) => wrapper.findAll('button').find(b => b.text().includes(text))!

    await wrapper.setProps({ open: true })
    if (rescheduling) await button('Reschedule Exam').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Choose a time of day')
    expect(button('Afternoon').attributes()).toHaveProperty('disabled')
    expect(wrapper.text()).toContain('No afternoon availability')
    expect(wrapper.text()).not.toContain('South Center')
    expect(mockFetchAvailability).toHaveBeenCalledExactlyOnceWith(
      mockAssignment.id, undefined, undefined, rescheduling ? mockExistingReservation.id : undefined, 'narrowing'
    )
    await button('Morning').trigger('click')
    expect(wrapper.text()).toContain('Choose a day')
    await button('Thu, Oct 1').trigger('click')
    expect(button('9:00 AM').text()).toContain('Eastern (ET)')
    expect(wrapper.text()).not.toContain('America/New_York')
    await button('9:00 AM').trigger('click')
    expect(wrapper.text()).toContain('Review and confirm')
    expect(wrapper.text()).toContain('9:00 AM · Eastern (ET)')
    expect(mockCreateReservation).not.toHaveBeenCalled()
    expect(mockRescheduleReservation).not.toHaveBeenCalled()

    const result = { ...mockExistingReservation, facilityId: 'south', facilityName: 'South Center', seatNumber: 7 }
    mockCreateReservation.mockResolvedValue(result)
    mockRescheduleReservation.mockResolvedValue(result)
    await button(rescheduling ? 'Confirm Reschedule' : 'Confirm Reservation').trigger('click')
    await flushPromises()
    expect(rescheduling ? mockRescheduleReservation : mockCreateReservation).toHaveBeenCalledWith(
      rescheduling ? mockExistingReservation.id : mockAssignment.id, startTime
    )
    expect(wrapper.text()).toContain('Exam Confirmed!')
    expect(wrapper.text()).toContain('South Center')
    expect(wrapper.emitted('reserved')?.[0]).toEqual([result])
  })

  it('clears a previously picked time when the day or time of day changes', async () => {
    const day = (date: string, label: string, formattedTime: string, hour: string) => ({
      date, label,
      times: [{ startTime: `${date}T${hour}:00:00Z`, formattedTime, timezone: 'UTC' }]
    })
    mockFetchAvailability.mockResolvedValue({
      availabilityStatus: 'AVAILABLE',
      schedulingChoices: {
        morning: [day('2026-11-30', 'Mon, Nov 30', '9:00 AM', '09'), day('2026-11-29', 'Sun, Nov 29', '10:00 AM', '10')],
        afternoon: [day('2026-11-30', 'Mon, Nov 30', '2:00 PM', '14')]
      }
    })
    const wrapper = mount(CbtfScheduleModal, { props: { open: true, assignment: mockAssignment }, global: { stubs } })
    await flushPromises()
    const button = (label: string) => wrapper.findAll('button').find((candidate) => candidate.text().includes(label))!
    const click = (label: string) => button(label).trigger('click')
    await click('Morning')
    await click('Mon, Nov 30')
    await click('9:00 AM')
    await click('Back')
    await click('Back')
    await click('Sun, Nov 29')
    expect(button('Next').attributes()).toHaveProperty('disabled')
    expect(wrapper.text()).not.toContain('9:00 AM')
    await click('10:00 AM')
    await click('Back')
    await click('Back')
    await click('Back')
    await click('Afternoon')
    expect(button('Next').attributes()).toHaveProperty('disabled')
    expect(wrapper.text()).not.toContain('Sun, Nov 29')
    await click('Mon, Nov 30')
    expect(button('Next').attributes()).toHaveProperty('disabled')
    expect(wrapper.text()).toContain('2:00 PM')
    expect(wrapper.text()).not.toContain('10:00 AM')
  })

  it('explains when the chosen day has no suggested times', async () => {
    mockFetchAvailability.mockResolvedValue({
      availabilityStatus: 'AVAILABLE',
      schedulingChoices: {
        morning: [],
        afternoon: [{ date: '2026-11-30', label: 'Mon, Nov 30', times: [] }]
      }
    })
    const wrapper = mount(CbtfScheduleModal, { props: { open: true, assignment: mockAssignment }, global: { stubs } })
    await flushPromises()
    const button = (label: string) => wrapper.findAll('button').find((candidate) => candidate.text() === label)!
    expect(wrapper.text()).toContain('No morning availability')
    await button('Afternoon').trigger('click')
    await button('Mon, Nov 30').trigger('click')
    expect(wrapper.get('[role="status"]').text()).toContain('No suggested times are available')
    expect(button('Next').attributes()).toHaveProperty('disabled')
  })

  it('shows the current reservation testing center, exam interval, and workstation', () => {
    const startTime = '2026-11-30T13:45:00.000Z'
    const endTime = '2026-11-30T15:45:00.000Z'
    const wrapper = mount(CbtfScheduleModal, {
      props: {
        open: true,
        assignment: mockAssignment,
        existingReservation: {
          ...mockExistingReservation,
          facilityName: 'Main CBTF Facility',
          startTime,
          endTime,
          seatNumber: 6
        }
      },
      global: { stubs }
    })

    expect(wrapper.text()).toContain('Current Reservation')
    expect(wrapper.findAll('dt').map((label) => label.text())).toEqual([
      'Testing Center',
      'Exam Time',
      'Seat'
    ])
    const date = new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    })
    const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
    const start = new Date(startTime)
    expect(wrapper.findAll('dd').map((value) => value.text())).toEqual([
      'Main CBTF Facility',
      `${date.format(start)}, ${time.format(start)} – ${time.format(new Date(endTime))}`,
      'Workstation #6'
    ])
    expect(wrapper.text()).toContain('Reschedule Exam')
    expect(wrapper.text()).toContain('Cancel Reservation')
  })

  it('shows a fallback when the current reservation has no facility name', () => {
    const wrapper = mount(CbtfScheduleModal, {
      props: { open: true, assignment: mockAssignment, existingReservation: mockExistingReservation },
      global: { stubs }
    })

    expect(wrapper.text()).toContain('Testing center unavailable')
    expect(wrapper.text()).toContain('Workstation #12')
    expect(wrapper.text()).toContain('Reschedule Exam')
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
    await flushPromises()

    // Expect availability was fetched
    expect(mockFetchAvailability).toHaveBeenCalledWith('asg-cbtf-1', undefined, undefined, 'res-1', 'narrowing')

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
    expect(wrapper.text()).toContain('Workstation #12')
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
