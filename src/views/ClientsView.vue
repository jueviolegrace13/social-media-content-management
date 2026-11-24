<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import Button from 'primevue/button'
import Column from 'primevue/column'
import DataTable from 'primevue/datatable'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import MultiSelect from 'primevue/multiselect'
import Tag from 'primevue/tag'
import { useConfirm } from 'primevue/useconfirm'
import { computed, ref } from 'vue'
import { adminApi, API_SCOPES, type ApiClient, type Tenant } from '../api'

const queryClient = useQueryClient()
const confirm = useConfirm()
const clients = useQuery({ queryKey: ['clients'], queryFn: () => adminApi<{ clients: ApiClient[] }>('GET', '/clients') })
const tenants = useQuery({ queryKey: ['tenants'], queryFn: () => adminApi<{ tenants: Tenant[] }>('GET', '/tenants') })
const tenantName = computed(() => new Map((tenants.data.value?.tenants ?? []).map((t) => [t.id, t.name])))

const showCreate = ref(false)
const form = ref({ name: '', scopes: [] as string[], tenantIds: [] as string[], webhookUrl: '' })

/** A secret just created or rotated. Shown once, then gone from memory when the dialog closes. */
const revealed = ref<{ client: ApiClient; secret: string } | null>(null)
const copied = ref(false)

const refresh = () => queryClient.invalidateQueries({ queryKey: ['clients'] })

const create = useMutation({
  mutationFn: () =>
    adminApi<{ client: ApiClient; secret: string }>('POST', '/clients', {
      name: form.value.name,
      scopes: form.value.scopes,
      tenantIds: form.value.tenantIds,
      webhookUrl: form.value.webhookUrl || null,
    }),
  onSuccess: async (result) => {
    showCreate.value = false
    form.value = { name: '', scopes: [], tenantIds: [], webhookUrl: '' }
    revealed.value = result
    await refresh()
  },
})

const rotate = useMutation({
  mutationFn: (id: string) => adminApi<{ client: ApiClient; secret: string }>('POST', `/clients/${id}/rotate`),
  onSuccess: async (result) => {
    revealed.value = result
    await refresh()
  },
})

const revoke = useMutation({
  mutationFn: (id: string) => adminApi('POST', `/clients/${id}/revoke`),
  onSuccess: refresh,
})

function confirmRotate(client: ApiClient) {
  confirm.require({
    header: `Rotate ${client.name}'s secret?`,
    message: 'The current secret stops working immediately. Update the client app with the new one.',
    acceptProps: { label: 'Rotate', severity: 'warn' },
    rejectProps: { label: 'Cancel', severity: 'secondary', text: true },
    accept: () => rotate.mutate(client.id),
  })
}

function confirmRevoke(client: ApiClient) {
  confirm.require({
    header: `Revoke ${client.name}?`,
    message: 'Every request from this client is refused from now on. This cannot be undone.',
    acceptProps: { label: 'Revoke', severity: 'danger' },
    rejectProps: { label: 'Cancel', severity: 'secondary', text: true },
    accept: () => revoke.mutate(client.id),
  })
}

async function copySecret() {
  if (!revealed.value) return
  await navigator.clipboard.writeText(revealed.value.secret)
  copied.value = true
}

function closeRevealed() {
  revealed.value = null
  copied.value = false
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—')
</script>

<template>
  <div class="mb-4 flex items-center justify-between">
    <h1 class="text-xl font-semibold">API clients</h1>
    <Button label="New client" icon="pi pi-plus" size="small" @click="showCreate = true" />
  </div>

  <Message v-for="e in [clients.error.value, rotate.error.value, revoke.error.value].filter(Boolean)" :key="e!.message" severity="error" :closable="false">
    {{ e!.message }}
  </Message>
  <DataTable :value="clients.data.value?.clients ?? []" :loading="clients.isLoading.value" data-key="id" size="small">
    <template #empty>No API clients yet.</template>
    <Column field="name" header="Name" />
    <Column header="Client ID">
      <template #body="{ data }"><code class="text-xs">{{ data.id }}</code></template>
    </Column>
    <Column header="Scopes">
      <template #body="{ data }">{{ data.scopes.join(', ') || '—' }}</template>
    </Column>
    <Column header="Tenants">
      <template #body="{ data }">{{ data.tenantIds.map((id: string) => tenantName.get(id) ?? id).join(', ') || '—' }}</template>
    </Column>
    <Column header="Status">
      <template #body="{ data }">
        <Tag :value="data.status" :severity="data.status === 'active' ? 'success' : 'danger'" />
      </template>
    </Column>
    <Column header="Last used">
      <template #body="{ data }">{{ when(data.lastUsedAt) }}</template>
    </Column>
    <Column header="">
      <template #body="{ data }">
        <div v-if="data.status === 'active'" class="flex gap-1">
          <Button label="Rotate" size="small" text severity="warn" @click="confirmRotate(data)" />
          <Button label="Revoke" size="small" text severity="danger" @click="confirmRevoke(data)" />
        </div>
      </template>
    </Column>
  </DataTable>

  <Dialog v-model:visible="showCreate" header="New API client" modal class="w-full max-w-md">
    <form class="flex flex-col gap-4" @submit.prevent="create.mutate()">
      <label class="flex flex-col gap-1">
        <span class="text-sm font-medium">Name (lowercase, e.g. open-play)</span>
        <InputText v-model="form.name" required pattern="[a-z0-9][a-z0-9-]{1,62}" />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm font-medium">Scopes</span>
        <MultiSelect v-model="form.scopes" :options="[...API_SCOPES]" display="chip" />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm font-medium">Tenants it may act for</span>
        <MultiSelect v-model="form.tenantIds" :options="tenants.data.value?.tenants ?? []" option-label="name" option-value="id" display="chip" />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm font-medium">Webhook URL (optional, https)</span>
        <InputText v-model="form.webhookUrl" type="url" />
      </label>
      <Message v-if="create.error.value" severity="error" :closable="false">{{ create.error.value.message }}</Message>
      <Button type="submit" label="Create" :loading="create.isPending.value" />
    </form>
  </Dialog>

  <Dialog :visible="revealed !== null" header="Client secret" modal :closable="false" class="w-full max-w-lg">
    <div v-if="revealed" class="flex flex-col gap-3">
      <Message severity="warn" :closable="false">Copy this secret now. It won't be shown again.</Message>
      <div class="text-sm"><span class="font-medium">Client ID:</span> <code>{{ revealed.client.id }}</code></div>
      <code class="block break-all rounded bg-surface-100 p-3 text-sm dark:bg-surface-800">{{ revealed.secret }}</code>
      <div class="flex justify-end gap-2">
        <Button :label="copied ? 'Copied' : 'Copy'" :icon="copied ? 'pi pi-check' : 'pi pi-copy'" severity="secondary" @click="copySecret" />
        <Button label="I've saved it" @click="closeRevealed" />
      </div>
    </div>
  </Dialog>
</template>
