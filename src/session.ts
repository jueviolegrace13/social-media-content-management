import { defineStore } from 'pinia'
import { ref } from 'vue'
import { adminApi, ApiError, type Admin } from './api'

export const useSession = defineStore('session', () => {
  const admin = ref<Admin | null>(null)
  const checked = ref(false)

  async function load(): Promise<Admin | null> {
    try {
      admin.value = (await adminApi<{ admin: Admin }>('GET', '/me')).admin
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error
      admin.value = null
    }
    checked.value = true
    return admin.value
  }

  async function signIn(email: string, password: string, code: string): Promise<void> {
    admin.value = (await adminApi<{ admin: Admin }>('POST', '/auth/sign-in', { email, password, code })).admin
    checked.value = true
  }

  async function signOut(): Promise<void> {
    await adminApi('POST', '/auth/sign-out')
    admin.value = null
  }

  return { admin, checked, load, signIn, signOut }
})
