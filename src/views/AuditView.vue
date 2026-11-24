<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import Column from 'primevue/column'
import DataTable from 'primevue/datatable'
import Message from 'primevue/message'
import { adminApi, type AuditEntry } from '../api'

const audit = useQuery({ queryKey: ['audit'], queryFn: () => adminApi<{ entries: AuditEntry[] }>('GET', '/audit') })
</script>

<template>
  <h1 class="mb-4 text-xl font-semibold">Audit log</h1>
  <p class="mb-4 text-sm text-muted-color">The latest 100 entries.</p>
  <Message v-if="audit.error.value" severity="error" :closable="false">{{ audit.error.value.message }}</Message>
  <DataTable :value="audit.data.value?.entries ?? []" :loading="audit.isLoading.value" data-key="id" size="small">
    <template #empty>Nothing recorded yet.</template>
    <Column header="When">
      <template #body="{ data }">{{ new Date(data.createdAt).toLocaleString() }}</template>
    </Column>
    <Column field="action" header="Action" />
    <Column header="Actor">
      <template #body="{ data }">{{ data.actorType }}<span v-if="data.actorId" class="text-muted-color"> · {{ data.actorId.slice(0, 8) }}</span></template>
    </Column>
    <Column header="Target">
      <template #body="{ data }">{{ data.targetType ?? '' }}<span v-if="data.targetId" class="text-muted-color"> · {{ data.targetId.slice(0, 8) }}</span></template>
    </Column>
    <Column header="Details">
      <template #body="{ data }"><code v-if="data.details" class="text-xs">{{ JSON.stringify(data.details) }}</code></template>
    </Column>
    <Column field="ip" header="IP" />
  </DataTable>
</template>
