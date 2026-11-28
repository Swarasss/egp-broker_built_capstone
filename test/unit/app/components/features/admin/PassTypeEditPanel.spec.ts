import { flushPromises, mount } from '@vue/test-utils'
import { useTemplateRef } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PassTypeEditPanel from '~/components/features/admin/PassTypeEditPanel.vue'
import type { AssignmentRow } from '@@/shared/models/assignment'
import { passTypeDataSchema } from '@@/shared/models/pass'
import en from '../../../../../../i18n/locales/en/common.json'

const request = vi.fn()
const error = vi.fn()
const assignments = [
  { id: 'assignment-1', title: 'Quiz' },
  { id: 'assignment-2', title: 'Quiz', eligibilities: [
    { passTypeId: 'pass-1', isAutomatic: false }
  ] },
  { id: 'assignment-3', title: 'Quiz 2', eligibilities: [
    { passTypeId: 'pass-1', isAutomatic: true }
  ] }
] as AssignmentRow[]

const translate = (key: string, params?: { label: string }) => {
  const text = key.split('.').reduce<any>((entry, part) => entry?.[part], en) ?? key
  return params ? text.replace('{label}', params.label) : text
}

const input = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)">'
}

const stubs = {
  USlideover: { template: '<div><slot name="body" /><slot name="footer" /></div>' },
  UForm: { template: '<form @submit.prevent="$emit(\'submit\')"><slot /></form>' },
  UFormField: {
    props: ['name', 'description'],
    template: '<div :data-field="name"><slot />{{ description }}</div>'
  },
  BaseFormInput: input,
  UInput: input,
  USelect: {
    props: ['modelValue', 'items'],
    template: '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="item in items" :value="item.value">{{ item.label }}</option></select>'
  },
  USelectMenu: {
    props: ['modelValue', 'items', 'valueKey'],
    template: '<select multiple @change="$emit(\'update:modelValue\', Array.from($event.target.selectedOptions, o => o.value))"><option v-for="item in items" :value="item[valueKey]" :selected="modelValue.includes(item[valueKey])">{{ item.label }}</option></select>'
  },
  USwitch: true
}

function panel(passType: ReturnType<typeof passTypeDataSchema.parse> | null = null) {
  return mount(PassTypeEditPanel, {
    props: { open: true, passType, assignments },
    global: { stubs, mocks: { $t: translate } }
  })
}

describe('Pass type form', () => {
  beforeEach(() => {
    request.mockReset().mockResolvedValue({})
    error.mockReset()
    vi.stubGlobal('useNotifications', () => ({ success: vi.fn(), error }))
    vi.stubGlobal('useI18n', () => ({ t: translate }))
    vi.stubGlobal('useTemplateRef', useTemplateRef)
    vi.stubGlobal('$fetch', request)
  })
  afterEach(() => vi.unstubAllGlobals())

  it.each([
    ['retake', false, false],
    ['extension', true, false],
    ['cutoff', false, true]
  ])('submits IDs, numbers and the flags for %s', async (purpose, extensionOnly, extendsCutoffOnly) => {
    const wrapper = panel()
    const assignment = wrapper.get('[data-field="assignmentIds"] select')
    expect(assignment.findAll('option').slice(0, 2).map((option) => option.text())).toEqual([
      'Quiz (assignment-1)', 'Quiz (assignment-2)'
    ])
    expect(wrapper.get('details').attributes('open')).toBeUndefined()
    await wrapper.get('input[name="name"]').setValue('Exam pass')
    await assignment.setValue(['assignment-2'])
    await wrapper.get('[data-field="purpose"] select').setValue(purpose)
    await wrapper.get('[data-field="initialBalance"] input').setValue('1')
    await wrapper.get('[data-field="hoursPerPass"] input').setValue('1.5')
    await wrapper.get('[data-field="maxDaysPastDue"] input').setValue('1')
    await wrapper.get('[data-field="coolDownResetOffset"] input').setValue('0')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(request).toHaveBeenCalledWith('/api/me/pass-types', {
      method: 'POST',
      body: expect.objectContaining({
        assignmentIds: ['assignment-2'], initialBalance: 1, hoursPerPass: 1.5,
        maxDaysPastDue: 1, minDaysPastDue: null, coolDownPeriod: null, coolDownResetOffset: 0,
        extensionOnly, extendsCutoffOnly
      })
    })
  })

  it('requires eligibility for creation and accepts an advanced regex without explicit assignments', async () => {
    const wrapper = panel()
    await wrapper.get('input[name="name"]').setValue('Bulk quiz pass')
    await wrapper.get('form').trigger('submit')
    expect(request).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Select an assignment or enter a title pattern in Advanced Settings.'
    }))

    await wrapper.get('input[name="titlePattern"]').setValue('^Quiz')
    await wrapper.get('[data-field="minDaysPastDue"] input').setValue('2')
    await wrapper.get('[data-field="coolDownPeriod"] input').setValue('1')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(request).toHaveBeenCalledWith('/api/me/pass-types', {
      method: 'POST',
      body: expect.objectContaining({
        assignmentIds: [], titlePattern: '^Quiz', minDaysPastDue: 2,
        maxDaysPastDue: null, coolDownPeriod: 1
      })
    })
  })

  it('shows a field-specific error for a nonnumeric value', async () => {
    const wrapper = panel()
    await wrapper.get('input[name="name"]').setValue('Exam pass')
    await wrapper.get('[data-field="assignmentIds"] select').setValue(['assignment-1'])
    await wrapper.get('[data-field="maxDaysPastDue"] input').setValue('soon')
    await wrapper.get('form').trigger('submit')
    expect(error).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Max Days Past Due must be a number.'
    }))
    expect(request).not.toHaveBeenCalled()
  })

  it('edits explicit selection alongside the existing advanced regex and preserves both legacy flags', async () => {
    const wrapper = panel(passTypeDataSchema.parse({
      id: 'pass-1', name: 'Existing', description: null,
      extensionOnly: true, extendsCutoffOnly: true, allowRequests: false,
      initialBalance: 3, hoursPerPass: 24, titlePattern: '^Quiz',
      minDaysPastDue: null, maxDaysPastDue: 3, coolDownPeriod: null,
      coolDownUnit: null, coolDownReset: null, coolDownResetOffset: null,
      createdAt: '2030-01-01'
    }))
    expect(wrapper.get('details').attributes()).toHaveProperty('open')
    expect(wrapper.get('input[name="titlePattern"]').element.value).toBe('^Quiz')
    const assignment = wrapper.get('[data-field="assignmentIds"] select')
    expect(Array.from((assignment.element as HTMLSelectElement).selectedOptions, ({ value }) => value))
      .toEqual(['assignment-2'])
    wrapper.getComponent(stubs.USelectMenu).vm.$emit('update:modelValue', ['assignment-1', 'assignment-2'])
    await wrapper.get('[data-field="maxDaysPastDue"] input').setValue('')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(request).toHaveBeenCalledWith('/api/me/pass-types/pass-1', {
      method: 'PATCH',
      body: expect.objectContaining({
        titlePattern: '^Quiz', assignmentIds: ['assignment-1', 'assignment-2'], maxDaysPastDue: null,
        extensionOnly: true, extendsCutoffOnly: true
      })
    })
  })

  it('replaces raw API validation structures with a readable message', async () => {
    request.mockRejectedValue({ data: { statusCode: 400, message: '[{"expected":"number"}]' } })
    const wrapper = panel()
    await wrapper.get('input[name="name"]').setValue('Exam pass')
    await wrapper.get('[data-field="assignmentIds"] select').setValue(['assignment-1'])
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(error).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Check the pass settings and try again.'
    }))
  })
})
