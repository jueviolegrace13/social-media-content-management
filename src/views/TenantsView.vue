<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import Button from 'primevue/button'
import Column from 'primevue/column'
import DataTable from 'primevue/datatable'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import { ref } from 'vue'
import { adminApi, type Tenant } from '../api'

const queryClient = useQueryClient()
const tenants = useQuery({ queryKey: ['tenants'], queryFn: () => adminApi<{ tenants: Tenant[] }>('GET', '/tenants') })

const showCreate = ref(false)
const form = ref({ name: '', kind: 'club' as Tenant['kind'], externalRef: '' })
const kinds = [
  { label: 'Platform (Open Play itself)', value: 'platform' },
  { label: 'Club', value: 'club' },
  { label: 'Business', value: 'business' },
]

const create = useMutation({
  mutationFn: () =>
    adminApi('POST', '/tenants', { name: form.value.name, kind: form.value.kind, externalRef: form.value.externalRef || null }),
  onSuccess: async () => {
    showCreate.value = false
    form.value = { name: '', kind: 'club', externalRef: '' }
    await queryClient.invalidateQueries({ queryKey: ['tenants'] })
  },
})

const setStatus = useMutation({
  mutationFn: (t: Tenant) => adminApi('POST', `/tenants/${t.id}/status`, { status: t.status === 'active' ? 'suspended' : 'active' }),
  onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tenants'] }),
})
</script>

<template>
  <div class="mb-4 flex items-center justify-between">
    <h1 class="text-xl font-semibold">Tenants</h1>
    <Button label="New tenant" icon="pi pi-plus" size="small" @click="showCreate = true" />
  </div>

  <Message v-if="tenants.error.value" severity="error" :closable="false">{{ tenants.error.value.message }}</Message>
  <DataTable :value="tenants.data.value?.tenants ?? []" :loading="tenants.isLoading.value" data-key="id" size="small">
    <template #empty>No tenants yet.</template>
    <Column field="name" header="Name" />
    <Column field="kind" header="Kind" />
    <Column field="externalRef" header="External ref" />
    <Column header="Status">
      <template #body="{ data }">
        <Tag :value="data.status" :severity="data.status === 'active' ? 'success' : 'warn'" />
      </template>
    </Column>
    <Column header="ID">
      <template #body="{ data }"><code class="text-xs">{{ data.id }}</code></template>
    </Column>
    <Column header="">
      <template #body="{ data }">
        <Button
          :label="data.status === 'active' ? 'Suspend' : 'Reactivate'"
          size="small"
          text
          :severity="data.status === 'active' ? 'danger' : 'secondary'"
          @click="setStatus.mutate(data)"
        />
      </template>
    </Column>
  </DataTable>

  <Dialog v-model:visible="showCreate" header="New tenant" modal class="w-full max-w-md">
    <form class="flex flex-col gap-4" @submit.prevent="create.mutate()">
      <label class="flex flex-col gap-1">
        <span class="text-sm font-medium">Name</span>
        <InputText v-model="form.name" required maxlength="120" />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm font-medium">Kind</span>
        <Select v-model="form.kind" :options="kinds" option-label="label" option-value="value" />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm font-medium">External ref (optional, e.g. Open Play club ID)</span>
        <InputText v-model="form.externalRef" maxlength="120" />
      </label>
      <Message v-if="create.error.value" severity="error" :closable="false">{{ create.error.value.message }}</Message>
      <Button type="submit" label="Create" :loading="create.isPending.value" />
    </form>
  </Dialog>
</template>
