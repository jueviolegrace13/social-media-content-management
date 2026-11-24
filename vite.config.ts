import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5174,
    proxy: { '/api': `http://localhost:${process.env.API_PORT ?? 3001}` },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Every API test file starts its own in-memory Postgres and applies all migrations.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
})
