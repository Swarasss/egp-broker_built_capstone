import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import AssignmentEditPanel from '~/components/features/admin/AssignmentEditPanel.vue'

vi.stubGlobal('useTemplateRef', () => ref(null))

const mockNotifications = {
  success: vi.fn(),
  error: vi.fn()
}
vi.stubGlobal('useNotifications', () => mockNotifications)

const mockToast = {
  add: vi.fn()
}
vi.stubGlobal('useToast', () => mockToast)

const mockToastHelpers = {
  success: vi.fn(),
  showError: vi.fn()
}
vi.stubGlobal('useToastHelpers', () => mockToastHelpers)

const mockFetch = vi.fn().mockResolvedValue({})
vi.stubGlobal('$fetch', mockFetch)

const globalStubs = {
  USlideover: {
    template: '<div><slot name="body" /></div>'
  },
  UForm: {
    template: '<form @submit.prevent="$emit(\'submit\')"><slot /></form>'
  },
  UFormField: {
    template: '<div><slot /></div>'
  },
  USwitch: {
    props: ['modelValue'],
    template:
      '<input type="checkbox" role="switch" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" />'
  },
  USelectMenu: {
    props: ['modelValue'],
    template: '<div class="select-menu" />'
  },
  BaseFormInput: {
    props: ['modelValue', 'label', 'name', 'type'],
    template:
      '<div class="base-form-input"><label>{{ label }}</label><input :name="name" :type="type || \'text\'" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" /></div>'
  },
  UBadge: {
    template: '<span class="badge"><slot /></span>'
  }
}

describe('AssignmentEditPanel.vue - GTA Grading Interviews', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('populates GTA interview fields when opening in edit mode', async () => {
    const assignment = {
      id: 'asg-1',
      title: 'Project 1',
      canvasAssignmentId: 'canvas-101',
      dueDate: '2026-09-25T17:00:00.000Z',
      availableFrom: '2026-09-20T09:00:00.000Z',
      acceptUntil: '2026-09-26T23:59:00.000Z',
      hasInterviews: true,
      interviewWindowStart: '2026-09-21T09:00:00.000Z',
      interviewWindowEnd: '2026-09-25T17:00:00.000Z',
      eligibilities: []
    }

    const wrapper = mount(AssignmentEditPanel, {
      props: {
        open: true,
        assignment,
        courseId: 'course-1',
        passTypes: []
      },
      global: {
        stubs: globalStubs
      }
    })

    await flushPromises()

    // Find the GTA interview inputs
    const inputs = wrapper.findAll('input')
    const startInput = inputs.find((i) => i.attributes('name') === 'interviewWindowStart')
    const endInput = inputs.find((i) => i.attributes('name') === 'interviewWindowEnd')

    expect(startInput).toBeDefined()
    expect(endInput).toBeDefined()
    expect(startInput?.element.value).toContain('2026-09-21')
    expect(endInput?.element.value).toContain('2026-09-25')
  })

  it('submits updated hasInterviews and window dates on submit', async () => {
    const assignment = {
      id: 'asg-1',
      title: 'Project 1',
      canvasAssignmentId: 'canvas-101',
      dueDate: null,
      availableFrom: null,
      acceptUntil: null,
      hasInterviews: true,
      interviewWindowStart: '2026-09-21T09:00:00.000Z',
      interviewWindowEnd: '2026-09-25T17:00:00.000Z',
      eligibilities: []
    }

    const wrapper = mount(AssignmentEditPanel, {
      props: {
        open: true,
        assignment,
        courseId: 'course-1',
        passTypes: []
      },
      global: {
        stubs: globalStubs
      }
    })

    await flushPromises()

    const form = wrapper.find('form')
    await form.trigger('submit')
    await flushPromises()

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/me/assignments/asg-1',
      expect.objectContaining({
        method: 'PATCH',
        body: expect.objectContaining({
          hasInterviews: true,
          interviewWindowStart: expect.any(String),
          interviewWindowEnd: expect.any(String)
        })
      })
    )
  })
})

describe('AssignmentEditPanel.vue - CBTF duration', () => {
  beforeEach(() => vi.clearAllMocks())

  function mountPanel() {
    return mount(AssignmentEditPanel, {
      props: {
        open: true, courseId: 'c1', passTypes: [],
        assignment: {
          id: 'a1', title: 'Exam', canvasAssignmentId: null,
          dueDate: null, availableFrom: null, acceptUntil: null,
          isSchedulable: true, cbtfDurationMinutes: 37
        }
      },
      global: { stubs: globalStubs }
    })
  }

  it('loads an existing custom duration and submits an edited numeric duration', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    const input = wrapper.get<HTMLInputElement>('input[name="cbtfDurationMinutes"]')
    expect(input.element.value).toBe('37')
    await input.setValue('120')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(mockFetch).toHaveBeenCalledWith('/api/me/assignments/a1', {
      method: 'PATCH', body: expect.objectContaining({ cbtfDurationMinutes: 120 })
    })
    wrapper.unmount()
  })

  it('resets a previous custom duration to 60 in create mode', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.setProps({ open: false })
    await wrapper.setProps({ assignment: null, open: true })
    await wrapper.findAll('input[role="switch"]')[0]!.setValue(true)
    expect(wrapper.get<HTMLInputElement>('input[name="cbtfDurationMinutes"]').element.value).toBe('60')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(mockFetch).toHaveBeenCalledWith('/api/me/assignments', {
      method: 'POST', body: expect.objectContaining({ courseId: 'c1', cbtfDurationMinutes: 60 })
    })
    wrapper.unmount()
  })

  it('submits null when CBTF is disabled', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.findAll('input[role="switch"]')[0]!.setValue(false)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(mockFetch).toHaveBeenCalledWith('/api/me/assignments/a1', {
      method: 'PATCH', body: expect.objectContaining({ isSchedulable: false, cbtfDurationMinutes: null })
    })
    wrapper.unmount()
  })
})
