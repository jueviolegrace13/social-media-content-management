<script setup lang="ts">
import Button from 'primevue/button'
import InputOtp from 'primevue/inputotp'
import InputText from 'primevue/inputtext'
import Message from 'primevue/message'
import Password from 'primevue/password'
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSession } from '../session'

const session = useSession()
const router = useRouter()
const route = useRoute()

const email = ref('')
const password = ref('')
const code = ref('')
const error = ref('')
const busy = ref(false)

async function submit() {
  error.value = ''
  busy.value = true
  try {
    await session.signIn(email.value, password.value, code.value)
    const next = typeof route.query.next === 'string' && route.query.next.startsWith('/admin') ? route.query.next : '/admin'
    await router.replace(next)
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Sign-in failed'
    code.value = ''
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main class="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
    <h1 class="mb-1 text-2xl font-semibold">Platform admin</h1>
    <p class="mb-6 text-sm text-muted-color">Sign in with your password and authenticator code.</p>
    <form class="flex flex-col gap-4" @submit.prevent="submit">
      <label class="flex flex-col gap-1">
        <span class="text-sm font-medium">Email</span>
        <InputText v-model="email" type="email" autocomplete="username" required />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm font-medium">Password</span>
        <Password v-model="password" :feedback="false" toggle-mask input-class="w-full" class="w-full" autocomplete="current-password" required />
      </label>
      <div class="flex flex-col gap-1">
        <span class="text-sm font-medium">Authenticator code</span>
        <InputOtp v-model="code" :length="6" integer-only />
      </div>
      <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
      <Button type="submit" label="Sign in" :loading="busy" :disabled="code.length !== 6" />
    </form>
  </main>
</template>
