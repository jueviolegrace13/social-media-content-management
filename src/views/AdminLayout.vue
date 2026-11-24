<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query'
import Button from 'primevue/button'
import { useRouter } from 'vue-router'
import { useSession } from '../session'

const session = useSession()
const router = useRouter()
const queryClient = useQueryClient()

const links = [
  { to: { name: 'tenants' }, label: 'Tenants', icon: 'pi pi-building' },
  { to: { name: 'clients' }, label: 'API clients', icon: 'pi pi-key' },
  { to: { name: 'audit' }, label: 'Audit log', icon: 'pi pi-list' },
]

async function signOut() {
  await session.signOut()
  queryClient.clear()
  await router.replace({ name: 'sign-in' })
}
</script>

<template>
  <div class="min-h-screen">
    <header class="border-b border-surface-200 bg-surface-0 dark:border-surface-800 dark:bg-surface-900">
      <div class="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <span class="font-semibold">Platform admin</span>
        <nav class="flex flex-wrap gap-1">
          <RouterLink
            v-for="link in links"
            :key="link.label"
            :to="link.to"
            class="rounded px-3 py-1.5 text-sm hover:bg-surface-100 dark:hover:bg-surface-800"
            active-class=""
            exact-active-class="bg-surface-100 font-medium dark:bg-surface-800"
          >
            <i :class="link.icon" class="mr-1 text-xs" />{{ link.label }}
          </RouterLink>
        </nav>
        <div class="ml-auto flex items-center gap-3 text-sm">
          <span class="text-muted-color">{{ session.admin?.email }}</span>
          <Button label="Sign out" size="small" severity="secondary" text @click="signOut" />
        </div>
      </div>
    </header>
    <main class="mx-auto max-w-5xl px-4 py-6">
      <RouterView />
    </main>
  </div>
</template>
