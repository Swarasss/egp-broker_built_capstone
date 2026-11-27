<template>
  <FeaturesCbtfWorkstationsPanel />
</template>

<script setup lang="ts">
import FeaturesCbtfWorkstationsPanel from '~/components/features/cbtf/CbtfWorkstationsPanel.vue'

definePageMeta({ middleware: ['admin-only'] })

const { setTitle } = useAdminPageTitle()
watchEffect(() => setTitle('Workstations'))
useSeo('admin')
</script>
