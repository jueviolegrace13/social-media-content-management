<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import Button from 'primevue/button'
import Column from 'primevue/column'
import DataTable from 'primevue/datatable'
import Dialog from 'primevue/dialog'
import Message from 'primevue/message'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import { computed, ref } from 'vue'
import { adminApi, label, statusSeverity, type Post, type Tenant } from '../api'

const queryClient = useQueryClient()
const status = ref<string | null>(null)
const statuses = ['scheduled', 'publishing', 'published', 'partially_published', 'failed', 'cancelled', 'removed'].map((s) => ({ label: label(s), value: s }))

const postsQuery = useQuery({
  queryKey: computed(() => ['posts', status.value]),
  queryFn: () => adminApi<{ posts: Post[] }>('GET', `/posts${status.value ? `?status=${status.value}` : ''}`),
  refetchInterval: 30_000,
})
const tenants = useQuery({ queryKey: ['tenants'], queryFn: () => adminApi<{ tenants: Tenant[] }>('GET', '/tenants') })
const tenantName = computed(() => new Map((tenants.data.value?.tenants ?? []).map((t) => [t.id, t.name])))

// Details with every attempt.
const openId = ref<string | null>(null)
const detail = useQuery({
  queryKey: computed(() => ['post', openId.value]),
  queryFn: () => adminApi<{ post: Post }>('GET', `/posts/${openId.value}`),
  enabled: computed(() => openId.value !== null),
})

const retry = useMutation({
  mutationFn: (v: { postId: string; targetId: string }) => adminApi('POST', `/posts/${v.postId}/targets/${v.targetId}/retry`),
  onSuccess: async () => {
    await queryClient.invalidateQueries({ queryKey: ['posts'] })
    await queryClient.invalidateQueries({ queryKey: ['post'] })
  },
})

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—')
const short = (text: string) => (text.length > 90 ? `${text.slice(0, 90)}…` : text || '(no caption)')
</script>

<template>
  <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
    <h1 class="text-xl font-semibold">Posts</h1>
    <Select v-model="status" :options="statuses" option-label="label" option-value="value" placeholder="All statuses" show-clear size="small" class="w-52" />
  </div>

  <Message v-for="e in [postsQuery.error.value, retry.error.value].filter(Boolean)" :key="e!.message" severity="error" :closable="false" class="mb-3">
    {{ e!.message }}
  </Message>

  <DataTable :value="postsQuery.data.value?.posts ?? []" :loading="postsQuery.isLoading.value" data-key="id" size="small">
    <template #empty>No posts yet.</template>
    <Column header="Created">
      <template #body="{ data }">
        <div class="whitespace-nowrap text-sm">{{ when(data.created_at) }}</div>
        <div v-if="data.scheduled_for" class="text-xs text-muted-color">for {{ when(data.scheduled_for) }}</div>
      </template>
    </Column>
    <Column header="Post">
      <template #body="{ data }">
        <div class="max-w-sm text-sm">{{ short(data.caption) }}</div>
        <div class="text-xs text-muted-color">
          {{ tenantName.get(data.tenant_id) ?? 'tenant' }} · {{ data.source }}<span v-if="data.source_ref"> · {{ data.source_ref }}</span>
          <span v-if="data.media.length"> · {{ data.media.length }} image{{ data.media.length > 1 ? 's' : '' }}</span>
        </div>
      </template>
    </Column>
    <Column header="Status">
      <template #body="{ data }"><Tag :value="label(data.status)" :severity="statusSeverity(data.status)" /></template>
    </Column>
    <Column header="Destinations">
      <template #body="{ data }">
        <div v-for="t in data.targets" :key="t.id" class="mb-1 text-sm">
          <div class="flex flex-wrap items-center gap-2">
            <span>{{ t.account_name ?? 'Account' }}</span>
            <Tag :value="label(t.status)" :severity="statusSeverity(t.status)" class="text-xs" />
            <a v-if="t.permalink" :href="t.permalink" target="_blank" rel="noopener noreferrer" class="text-xs underline">View</a>
            <Button
              v-if="t.status === 'failed'"
              label="Retry"
              size="small"
              text
              severity="warn"
              :loading="retry.isPending.value && retry.variables.value?.targetId === t.id"
              @click="retry.mutate({ postId: data.id, targetId: t.id })"
            />
          </div>
          <div v-if="t.error && t.status !== 'published'" class="max-w-sm text-xs text-red-600 dark:text-red-400">{{ t.error.message }}</div>
          <div v-if="t.next_attempt_at && t.attempt_count > 0" class="text-xs text-muted-color">Retry {{ when(t.next_attempt_at) }} (attempt {{ t.attempt_count + 1 }})</div>
        </div>
      </template>
    </Column>
    <Column header="">
      <template #body="{ data }"><Button label="History" size="small" text @click="openId = data.id" /></template>
    </Column>
  </DataTable>

  <Dialog :visible="openId !== null" header="Publishing history" modal class="w-full max-w-2xl" @update:visible="(v: boolean) => !v && (openId = null)">
    <p v-if="detail.isLoading.value" class="text-sm">Loading…</p>
    <div v-else-if="detail.data.value" class="flex flex-col gap-4">
      <p class="whitespace-pre-wrap text-sm">{{ detail.data.value.post.caption || '(no caption)' }}</p>
      <div v-for="t in detail.data.value.post.targets" :key="t.id">
        <div class="mb-2 flex items-center gap-2 font-medium">
          {{ t.account_name }} <Tag :value="label(t.status)" :severity="statusSeverity(t.status)" />
          <code v-if="t.external_post_id" class="text-xs font-normal">{{ t.external_post_id }}</code>
        </div>
        <table class="w-full text-left text-xs">
          <thead>
            <tr class="text-muted-color">
              <th class="py-1 pr-3">Started</th>
              <th class="py-1 pr-3">Outcome</th>
              <th class="py-1 pr-3">HTTP</th>
              <th class="py-1 pr-3">Meta code</th>
              <th class="py-1">Message</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="a in t.attempts ?? []" :key="a.id" class="border-t border-surface-200 dark:border-surface-700">
              <td class="py-1 pr-3 whitespace-nowrap">{{ when(a.started_at) }}</td>
              <td class="py-1 pr-3">{{ a.outcome ? label(a.outcome) : 'running' }}</td>
              <td class="py-1 pr-3">{{ a.http_status ?? '—' }}</td>
              <td class="py-1 pr-3">{{ a.meta_error_code ?? '—' }}<span v-if="a.meta_error_subcode">/{{ a.meta_error_subcode }}</span></td>
              <td class="py-1">{{ a.message ?? (a.external_post_id ? `Published as ${a.external_post_id}` : '') }}</td>
            </tr>
            <tr v-if="(t.attempts ?? []).length === 0"><td colspan="5" class="py-1 text-muted-color">No attempts yet.</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </Dialog>
</template>
