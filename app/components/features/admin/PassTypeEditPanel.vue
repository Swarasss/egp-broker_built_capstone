<template>
  <USlideover
    v-model:open="open"
    :title="isEdit ? $t('admin.passType.panelTitleEdit') : $t('admin.passType.panelTitleCreate')"
    :description="panelDescription"
  >
    <template #body>
      <UForm ref="formRef" :state="state" @submit="handleSubmit">
        <div class="space-y-6">
          <BaseFormInput
            v-model="state.name"
            name="name"
            :label="$t('admin.passType.nameLabel')"
            :placeholder="$t('admin.passType.namePlaceholder')"
            required
          />
          <BaseFormInput
            v-model="state.description"
            name="description"
            :label="$t('admin.passType.descriptionLabel')"
            :placeholder="$t('admin.passType.descriptionPlaceholder')"
          />

          <UFormField
            :label="t('admin.passType.assignmentLabel')"
            :description="t('admin.passType.assignmentDescription')"
            name="assignmentIds"
          >
            <USelectMenu
              v-model="selectedAssignmentIds"
              :items="assignmentOptions"
              value-key="value"
              multiple
              :disabled="!assignments"
              :placeholder="t('admin.passType.assignmentPlaceholder')"
              class="w-full"
            />
          </UFormField>

          <div class="grid grid-cols-2 gap-4">
            <UFormField
              v-for="field in basicNumbers"
              :key="field.key"
              :name="field.key"
              :label="t(field.label)"
              required
            >
              <UInput
                v-model="state[field.key]"
                :inputmode="field.decimal ? 'decimal' : 'numeric'"
                class="w-full"
              />
            </UFormField>
          </div>

          <UFormField
            :label="t('admin.passType.purposeLabel')"
            :description="state.purpose === 'retake' ? t('admin.passType.retakeDescription') : undefined"
            name="purpose"
          >
            <USelect v-model="state.purpose" :items="purposeOptions" class="w-full" />
          </UFormField>

          <UFormField
            :label="t('admin.passType.allowRequestsLabel')"
            :description="t('admin.passType.allowRequestsDescription')"
          >
            <USwitch v-model="state.allowRequests" />
          </UFormField>

          <details :open="advancedOpen" @toggle="advancedOpen = ($event.currentTarget as HTMLDetailsElement).open">
            <summary class="cursor-pointer font-semibold">{{ t('admin.passType.advancedSettings') }}</summary>
            <div class="space-y-4 pt-4">
              <BaseFormInput
                v-model="state.titlePattern"
                name="titlePattern"
                :label="t('admin.passType.titlePatternLabel')"
                :placeholder="t('admin.passType.titlePatternPlaceholder')"
                :description="t('admin.passType.titlePatternDescription')"
              />
              <div class="grid grid-cols-2 gap-4">
                <UFormField
                  v-for="field in advancedNumbers"
                  :key="field.key"
                  :name="field.key"
                  :label="t(field.label)"
                >
                  <UInput
                    v-model="state[field.key]"
                    inputmode="numeric"
                    class="w-full"
                    :placeholder="t('admin.passType.nonePlaceholder')"
                  />
                </UFormField>
                <UFormField :label="t('admin.passType.unitLabel')" name="coolDownUnit">
                  <USelect v-model="state.coolDownUnit" :items="coolDownOptions" class="w-full" />
                </UFormField>
                <UFormField :label="t('admin.passType.resetLabel')" name="coolDownReset">
                  <USelect v-model="state.coolDownReset" :items="coolDownOptions" class="w-full" />
                </UFormField>
              </div>
            </div>
          </details>
        </div>
      </UForm>
    </template>

    <template #footer>
      <div class="flex gap-3 justify-end w-full">
        <UButton
          color="neutral"
          variant="outline"
          :label="$t('global.actions.cancel')"
          icon="i-lucide-x"
          :disabled="saving"
          @click="open = false"
        />
        <UButton
          color="primary"
          :label="isEdit ? $t('global.actions.save') : $t('global.actions.submit')"
          :icon="isEdit ? 'i-lucide-save' : 'i-lucide-plus'"
          :loading="saving"
          :disabled="saving"
          @click="formRef?.submit()"
        />
      </div>
    </template>
  </USlideover>
</template>

<script setup lang="ts">
import type { AssignmentRow } from '@@/shared/models/assignment'
import { createPassTypeSchema, type PassTypeData } from '@@/shared/models/pass'

const { success, error: showError } = useNotifications()
const { t } = useI18n()

const props = defineProps<{
  passType: PassTypeData | null
  assignments?: AssignmentRow[]
}>()

const emit = defineEmits<{
  saved: [id: string, updates: Partial<PassTypeData>]
  created: []
}>()

const open = defineModel<boolean>('open', { required: true })
const formRef = useTemplateRef('formRef')
const saving = ref(false)
const advancedOpen = ref(false)
const chosenAssignmentIds = ref<string[]>()
const isEdit = computed(() => !!props.passType)
const panelDescription = computed(() =>
  props.passType?.name || t('admin.passType.panelDescriptionCreate')
)

const basicNumbers = [
  { key: 'initialBalance', label: 'admin.passType.initialBalanceLabel', decimal: false },
  { key: 'hoursPerPass', label: 'admin.passType.hoursPerPassLabel', decimal: true }
] as const
const advancedNumbers = [
  { key: 'minDaysPastDue', label: 'admin.passType.minDaysPastDueLabel' },
  { key: 'maxDaysPastDue', label: 'admin.passType.maxDaysPastDueLabel' },
  { key: 'coolDownPeriod', label: 'admin.passType.periodLabel' },
  { key: 'coolDownResetOffset', label: 'admin.passType.resetOffsetLabel' }
] as const

const purposeFlags = {
  retake: { extensionOnly: false, extendsCutoffOnly: false },
  extension: { extensionOnly: true, extendsCutoffOnly: false },
  cutoff: { extensionOnly: false, extendsCutoffOnly: true },
  legacy: { extensionOnly: true, extendsCutoffOnly: true }
}
type Purpose = keyof typeof purposeFlags
type CoolDownUnit = NonNullable<PassTypeData['coolDownUnit']>

const purposeOptions = computed<{ value: Purpose; label: string }[]>(() => [
  { value: 'retake', label: t('admin.passType.purposeRetake') },
  { value: 'extension', label: t('admin.passType.purposeExtension') },
  { value: 'cutoff', label: t('admin.passType.purposeCutoff') },
  ...(props.passType?.extensionOnly && props.passType.extendsCutoffOnly
    ? [{ value: 'legacy' as const, label: t('admin.passType.purposeLegacy') }]
    : [])
])

const coolDownOptions = computed(() => [
  { label: t('admin.passType.nonePlaceholder'), value: 'none' as const },
  ...(['HOUR', 'DAY', 'WEEK'] as const).map((value) => ({ label: value, value }))
])

const assignmentOptions = computed(() => {
  const assignments = props.assignments ?? []
  const titleCounts = new Map<string | null, number>()
  for (const { title } of assignments) {
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1)
  }
  return assignments.map(({ id, title }) => ({
    value: id,
    label: title && titleCounts.get(title) === 1
      ? title
      : `${title ?? t('admin.passType.untitledAssignment')} (${id})`
  }))
})

const selectedAssignmentIds = computed({
  get: () => chosenAssignmentIds.value ?? (props.assignments ?? [])
    .filter((assignment) => assignment.eligibilities?.some((entry) =>
      entry.passTypeId === props.passType?.id && !entry.isAutomatic
    ))
    .map(({ id }) => id),
  set: (ids: string[]) => { chosenAssignmentIds.value = ids }
})

const state = reactive({
  name: '',
  description: '',
  titlePattern: '',
  initialBalance: '3',
  hoursPerPass: '24',
  purpose: 'retake' as Purpose,
  allowRequests: false,
  minDaysPastDue: '',
  maxDaysPastDue: '',
  coolDownPeriod: '',
  coolDownUnit: 'none' as CoolDownUnit | 'none',
  coolDownReset: 'none' as CoolDownUnit | 'none',
  coolDownResetOffset: ''
})

watch([() => props.passType, open], ([passType, isOpen]) => {
  if (!isOpen) return
  chosenAssignmentIds.value = undefined
  for (const { key } of basicNumbers) {
    state[key] = String(passType?.[key] ?? (key === 'initialBalance' ? 3 : 24))
  }
  for (const { key } of advancedNumbers) {
    state[key] = String(passType?.[key] ?? '')
  }
  state.name = passType?.name ?? ''
  state.description = passType?.description ?? ''
  state.titlePattern = passType?.titlePattern ?? ''
  state.purpose = passType?.extensionOnly
    ? (passType.extendsCutoffOnly ? 'legacy' : 'extension')
    : (passType?.extendsCutoffOnly ? 'cutoff' : 'retake')
  state.allowRequests = passType?.allowRequests ?? false
  state.coolDownUnit = passType?.coolDownUnit ?? 'none'
  state.coolDownReset = passType?.coolDownReset ?? 'none'
  advancedOpen.value = !!state.titlePattern || advancedNumbers.some(({ key }) => state[key] !== '') ||
    state.coolDownUnit !== 'none' || state.coolDownReset !== 'none'
}, { immediate: true })

class FormError extends Error {}

function readNumber(field: (typeof basicNumbers)[number] | (typeof advancedNumbers)[number], optional = false) {
  const value = String(state[field.key] ?? '').trim()
  const label = t(field.label)
  if (!value) {
    if (optional) return null
    throw new FormError(t('admin.passType.fieldRequired', { label }))
  }

  const amount = Number(value)
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(amount)) {
    throw new FormError(t('admin.passType.fieldNumber', { label }))
  }
  if (amount < 0 || (!('decimal' in field && field.decimal) && !Number.isSafeInteger(amount))) {
    throw new FormError(t(
      'decimal' in field && field.decimal ? 'admin.passType.fieldNonnegative' : 'admin.passType.fieldWhole',
      { label }
    ))
  }
  return amount
}

function buildBody() {
  const name = state.name.trim()
  if (!name) {
    throw new FormError(t('admin.passType.fieldRequired', { label: t('admin.passType.nameLabel') }))
  }
  const titlePattern = state.titlePattern.trim() || null
  if (titlePattern) {
    try {
      new RegExp(titlePattern)
    } catch {
      throw new FormError(t('admin.passType.invalidPattern'))
    }
  }
  if (!isEdit.value && !titlePattern && !selectedAssignmentIds.value.length) {
    throw new FormError(t('admin.passType.assignmentRequired'))
  }
  const assignmentIds = isEdit.value ? chosenAssignmentIds.value : selectedAssignmentIds.value
  const result = createPassTypeSchema.safeParse({
    name,
    description: state.description || null,
    titlePattern,
    ...purposeFlags[state.purpose],
    allowRequests: state.allowRequests,
    ...(props.assignments && assignmentIds !== undefined ? { assignmentIds } : {}),
    ...Object.fromEntries(basicNumbers.map(field => [field.key, readNumber(field)])),
    ...Object.fromEntries(advancedNumbers.map(field => [field.key, readNumber(field, true)])),
    coolDownUnit: state.coolDownUnit === 'none' ? null : state.coolDownUnit,
    coolDownReset: state.coolDownReset === 'none' ? null : state.coolDownReset
  })
  if (!result.success) throw new FormError(t('admin.passType.invalidForm'))
  return result.data
}

const handleSubmit = async () => {
  if (saving.value) return
  saving.value = true
  try {
    const body = buildBody()
    const passType = props.passType
    if (passType) {
      await $fetch(`/api/me/pass-types/${passType.id}`, { method: 'PATCH', body })
      success({
        title: t('admin.passType.notifications.updatedTitle'),
        message: t('admin.passType.notifications.updatedMessage')
      })
      const { assignmentIds, ...updates } = body
      emit('saved', passType.id, updates)
    } else {
      await $fetch('/api/me/pass-types', { method: 'POST', body })
      success({
        title: t('admin.passType.notifications.createdTitle'),
        message: t('admin.passType.notifications.createdMessage')
      })
      emit('created')
    }
    open.value = false
  } catch (err: unknown) {
    const response = (err as { data?: { statusCode?: number; data?: { reason?: string } } })?.data
    let message = t('admin.passType.notifications.errorDefault')
    if (err instanceof FormError) {
      message = err.message
    } else if (response?.data?.reason === 'INVALID_ASSIGNMENT_SELECTION') {
      message = t('admin.passType.invalidAssignments')
    } else if (response?.statusCode === 400) {
      message = t('admin.passType.invalidForm')
    }
    showError({
      title: t(isEdit.value ? 'admin.passType.notifications.updateFailedTitle' : 'admin.passType.notifications.createFailedTitle'),
      message
    })
  } finally {
    saving.value = false
  }
}
</script>
