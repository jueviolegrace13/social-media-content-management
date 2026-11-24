/**
 * `npm run dev:local`: the API on a local Postgres (PGlite) stored in ./.local-db, so you can try the app without
 * Neon. Data survives restarts; delete the folder to start over. Not used in production.
 *
 * The first run creates a local-only admin, dev@localhost.test with password `local-dev-password`, and prints its
 * TOTP secret. Encryption uses a throwaway key unless ENCRYPTION_KEYS is set.
 */
import './lib/loadEnv.js'
import { serve } from '@hono/node-server'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { setDb, type Db } from './db/client.js'
import * as schema from './db/schema.js'

// Stable per checkout, so secrets stored in .local-db stay readable across restarts. Local use only.
process.env.ENCRYPTION_KEYS ||= 'v1:bG9jYWwtZGV2LW9ubHktbm90LWEtcmVhbC1rZXkhISE='

const { app } = await import('./app.js')
const { createAdmin } = await import('./services/admins.js')
const { otpauthUri } = await import('./lib/totp.js')

const dataDir = process.env.LOCAL_DB_DIR ?? './.local-db'
const client = new PGlite(dataDir)
const db = drizzle(client, { schema })
await migrate(db, { migrationsFolder: './drizzle' })
setDb(db as unknown as Db)

const { rows } = await client.query<{ n: number }>('select count(*)::int as n from admin_users')
if (rows[0]!.n === 0) {
  const { totpSecret } = await createAdmin('dev@localhost.test', 'local-dev-password')
  console.log('Created local admin dev@localhost.test / local-dev-password')
  console.log(`TOTP secret (add to an authenticator app): ${totpSecret}`)
  console.log(otpauthUri(totpSecret, 'dev@localhost.test'))
}

const port = Number(process.env.API_PORT ?? 3001)
serve({ fetch: app.fetch, port }, () => console.log(`API on http://localhost:${port}/api (local database in ${dataDir})`))
