import { config } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

// `.env.local` first, then `.env`; dotenv never overrides vars already set (so real env vars win).
config({ path: '.env.local', quiet: true })
config({ path: '.env', quiet: true })

export default defineConfig({
  schema: './server/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
})
