<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import Button from 'primevue/button'
import Column from 'primevue/column'
import DataTable from 'primevue/datatable'
import Dialog from 'primevue/dialog'
import Message from 'primevue/message'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import { useConfirm } from 'primevue/useconfirm'
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { adminApi, label, statusSeverity, type PageChoice, type SocialAccount, type Tenant } from '../api'

const queryClient = useQueryClient()
const confirm = useConfirm()
const route = useRoute()
const router = useRouter()

const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => adminApi<{ accounts: SocialAccount[] }>('GET', '/accounts') })
const tenants = useQuery({ queryKey: ['tenants'], queryFn: () => adminApi<{ tenants: Tenant[] }>('GET', '/tenants') })
const tenantName = computed(() => new Map((tenants.data.value?.tenants ?? []).map((t) => [t.id, t.name])))
const refresh = () => queryClient.invalidateQueries({ queryKey: ['accounts'] })

// Connecting: a full-page trip to Facebook and back (the API answers with redirects).
const showConnect = ref(false)
const connectTenant = ref<string | null>(null)
function startConnect(tenantId: string) {
  window.location.href = `/api/admin/accounts/facebook/connect?tenantId=${encodeURIComponent(tenantId)}`
}

// Back from Facebook: ?connect=<login id> to pick a Page, or ?connect_error=...
const loginId = computed(() => (typeof route.query.connect === 'string' ? route.query.connect : null))
const connectError = computed(() => (typeof route.query.connect_error === 'string' ? route.query.connect_error : null))
const pending = useQuery({
  queryKey: computed(() => ['facebook-login', loginId.value]),
  queryFn: () => adminApi<{ tenantId: string; pages: PageChoice[] }>('GET', `/accounts/facebook/pending/${loginId.value}`),
  enabled: computed(() => loginId.value !== null),
  retry: false,
})
const select = useMutation({
  mutationFn: (pageId: string) => adminApi('POST', `/accounts/facebook/pending/${loginId.value}/select`, { pageId }),
  onSuccess: async () => {
    await refresh()
    await router.replace({ query: {} })
  },
})
const closePicker = () => router.replace({ query: {} })

const check = useMutation({ mutationFn: (id: string) => adminApi('POST', `/accounts/${id}/check`), onSuccess: refresh })
const disconnect = useMutation({ mutationFn: (id: string) => adminApi('POST', `/accounts/${id}/disconnect`), onSuccess: refresh })

function confirmDisconnect(account: SocialAccount) {
  confirm.require({
    header: `Disconnect ${account.name}?`,
    message: 'The stored token is deleted. Posts waiting for this Page will fail until it is connected again.',
    acceptProps: { label: 'Disconnect', severity: 'danger' },
    rejectProps: { label: 'Cancel', severity: 'secondary', text: true },
    accept: () => disconnect.mutate(account.id),
  })
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—')
const errors = computed(() => [accounts.error.value, check.error.value, disconnect.error.value].filter((e) => e !== null))
</script>

<template>
  <div class="mb-4 flex items-center justify-between">
    <h1 class="text-xl font-semibold">Connected accounts</h1>
    <Button label="Connect a Facebook Page" icon="pi pi-facebook" size="small" @click="showConnect = true" />
  </div>

  <Message v-if="connectError" severity="error" :closable="false" class="mb-3">
    {{
      connectError === 'cancelled'
        ? 'Facebook sign-in was cancelled.'
        : connectError === 'not_configured'
          ? 'Facebook Login is not configured on the server (META_APP_ID and META_APP_SECRET).'
          : 'Facebook sign-in failed. Try connecting again.'
    }}
  </Message>
  <Message v-for="e in errors" :key="e!.message" severity="error" :closable="false" class="mb-3">{{ e!.message }}</Message>

  <DataTable :value="accounts.data.value?.accounts ?? []" :loading="accounts.isLoading.value" data-key="id" size="small">
    <template #empty>No accounts connected yet.</template>
    <Column header="Page">
      <template #body="{ data }">
        <div class="font-medium">{{ data.name }}</div>
        <div class="text-xs text-muted-color">Page ID {{ data.external_id }}</div>
      </template>
    </Column>
    <Column header="Tenant">
      <template #body="{ data }">{{ tenantName.get(data.tenant_id) ?? data.tenant_id }}</template>
    </Column>
    <Column header="Account ID">
      <template #body="{ data }"><code class="text-xs">{{ data.id }}</code></template>
    </Column>
    <Column header="Status">
      <template #body="{ data }">
        <Tag :value="label(data.status)" :severity="statusSeverity(data.status)" />
        <div v-if="data.last_error" class="mt-1 max-w-xs text-xs text-red-600 dark:text-red-400">{{ data.last_error }}</div>
      </template>
    </Column>
    <Column header="Last checked">
      <template #body="{ data }">{{ when(data.last_checked_at) }}</template>
    </Column>
    <Column header="">
      <template #body="{ data }">
        <div class="flex gap-1">
          <Button v-if="data.status !== 'disconnected'" label="Check" size="small" text :loading="check.isPending.value && check.variables.value === data.id" @click="check.mutate(data.id)" />
          <Button
            :label="data.status === 'connected' ? 'Reconnect' : 'Connect again'"
            size="small"
            text
            :severity="data.status === 'connected' ? 'secondary' : 'warn'"
            @click="startConnect(data.tenant_id)"
          />
          <Button v-if="data.status !== 'disconnected'" label="Disconnect" size="small" text severity="danger" @click="confirmDisconnect(data)" />
        </div>
      </template>
    </Column>
  </DataTable>

  <Dialog v-model:visible="showConnect" header="Connect a Facebook Page" modal class="w-full max-w-md">
    <div class="flex flex-col gap-4">
      <p class="text-sm">
        You'll sign in with Facebook and choose a Page you manage. The Page's token is stored encrypted for the tenant
        you pick here.
      </p>
      <label class="flex flex-col gap-1">
        <span class="text-sm font-medium">Tenant</span>
        <Select v-model="connectTenant" :options="tenants.data.value?.tenants ?? []" option-label="name" option-value="id" placeholder="Choose a tenant" />
      </label>
      <Button label="Continue to Facebook" icon="pi pi-arrow-right" icon-pos="right" :disabled="!connectTenant" @click="startConnect(connectTenant!)" />
    </div>
  </Dialog>

  <Dialog :visible="loginId !== null" header="Choose a Page" modal class="w-full max-w-md" @update:visible="(v: boolean) => !v && closePicker()">
    <Message v-if="pending.error.value" severity="error" :closable="false">This Facebook sign-in has expired. Connect again.</Message>
    <p v-else-if="pending.isLoading.value" class="text-sm">Loading your Pages…</p>
    <div v-else class="flex flex-col gap-2">
      <p v-if="(pending.data.value?.pages ?? []).length === 0" class="text-sm">Facebook returned no Pages you manage for this app.</p>
      <div v-for="page in pending.data.value?.pages ?? []" :key="page.id" class="flex items-center justify-between gap-3 rounded border border-surface-200 p-3 dark:border-surface-700">
        <div>
          <div class="font-medium">{{ page.name }}</div>
          <div class="text-xs text-muted-color">Page ID {{ page.id }}</div>
          <div v-if="!page.canPublish" class="text-xs text-orange-600">You don't have the "create content" task on this Page, so posting will fail.</div>
        </div>
        <Button label="Connect" size="small" :loading="select.isPending.value" @click="select.mutate(page.id)" />
      </div>
      <Message v-if="select.error.value" severity="error" :closable="false">{{ select.error.value.message }}</Message>
      <p class="text-xs text-muted-color">Connected to tenant: {{ tenantName.get(pending.data.value?.tenantId ?? '') ?? '—' }}</p>
    </div>
  </Dialog>
</template>
