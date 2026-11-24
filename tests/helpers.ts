import { randomBytes } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { app } from '../server/app'
import { setDb, type Db } from '../server/db/client'
import * as schema from '../server/db/schema'
import { generateKey } from '../server/lib/encryption'
import { sign } from '../server/lib/signing'
import { timeStep, totpAt } from '../server/lib/totp'
import { createAdmin } from '../server/services/admins'

process.env.ENCRYPTION_KEYS ||= `v1:${generateKey()}`

/** Fresh in-process Postgres with the real migrations applied. */
export async function useTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite()
  const db = drizzle(client, { schema }) as unknown as Db
  await migrate(db as never, { migrationsFolder: './drizzle' })
  setDb(db)
  return {
    db,
    close: async () => {
      setDb(undefined)
      await client.close()
    },
  }
}

export const newNonce = () => randomBytes(16).toString('hex')

export interface SignOptions {
  timestamp?: string
  nonce?: string
  signature?: string
  clientId?: string
  headers?: Record<string, string>
}

/** A request signed the way a client app signs it (ADR-0007). */
export function signedRequest(
  client: { id: string; secret: string },
  method: string,
  path: string,
  body?: unknown,
  opts: SignOptions = {},
): Promise<Response> {
  const fullPath = `/api${path}`
  const raw = body === undefined ? '' : body instanceof Uint8Array ? body : JSON.stringify(body)
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000))
  const nonce = opts.nonce ?? newNonce()
  const signature = opts.signature ?? sign(client.secret, method, fullPath, timestamp, nonce, raw)
  return Promise.resolve(
    app.request(`http://localhost${fullPath}`, {
      method,
      headers: {
        'x-client-id': opts.clientId ?? client.id,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-signature': signature,
        ...(body !== undefined ? { 'content-type': body instanceof Uint8Array ? 'image/jpeg' : 'application/json' } : {}),
        ...opts.headers,
      },
      body: body === undefined ? undefined : (raw as BodyInit),
    }),
  )
}

export const ADMIN_PASSWORD = 'a-long-test-password-1'

export interface AdminClient {
  cookie: string
  request: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>
}

export function adminClient(cookie = ''): AdminClient {
  return {
    cookie,
    request: (method, path, body, headers = {}) =>
      Promise.resolve(
        app.request(`http://localhost/api/admin${path}`, {
          method,
          headers: {
            ...(cookie ? { cookie } : {}),
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      ),
  }
}

/** Creates an admin and signs it in; returns the cookie-carrying client and the TOTP secret. */
export async function signedInAdmin(email = 'admin@example.com'): Promise<{ admin: AdminClient; totpSecret: string }> {
  const { totpSecret } = await createAdmin(email, ADMIN_PASSWORD)
  const res = await adminClient().request('POST', '/auth/sign-in', {
    email,
    password: ADMIN_PASSWORD,
    code: totpAt(totpSecret, timeStep()),
  })
  if (res.status !== 200) throw new Error(`Sign-in failed: ${res.status}`)
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  return { admin: adminClient(cookie), totpSecret }
}
