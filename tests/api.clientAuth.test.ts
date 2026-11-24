import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apiClients, requestNonces } from '../server/db/schema'
import type { Db } from '../server/db/client'
import { createApiClient, revokeApiClient, rotateApiClientSecret } from '../server/services/apiClients'
import { overrideLimits } from '../server/services/rateLimit'
import { createTenant } from '../server/services/tenants'
import { newNonce, signedRequest, useTestDb } from './helpers'

let db: Db
let close: () => Promise<void>
let client: { id: string; secret: string }
let tenantId: string

beforeEach(async () => {
  ;({ db, close } = await useTestDb())
  tenantId = (await createTenant({ name: 'Open Play platform', kind: 'platform' })).id
  const created = await createApiClient({ name: 'open-play', scopes: ['posts:write'], tenantIds: [tenantId] })
  client = { id: created.client.id, secret: created.secret }
})

afterEach(async () => {
  await close()
})

describe('signed client requests', () => {
  it('a valid request gets the client and its tenants', async () => {
    const res = await signedRequest(client, 'GET', '/v1/whoami')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      client: { id: client.id, name: 'open-play', scopes: ['posts:write'] },
      tenants: [{ id: tenantId, name: 'Open Play platform', kind: 'platform', status: 'active' }],
    })
    const [row] = await db.select().from(apiClients).where(eq(apiClients.id, client.id))
    expect(row!.lastUsedAt).not.toBeNull()
  })

  it('the secret is stored encrypted, not in plain text', async () => {
    const [row] = await db.select().from(apiClients).where(eq(apiClients.id, client.id))
    expect(JSON.stringify(row)).not.toContain(client.secret)
  })

  it('refuses a bad signature', async () => {
    const res = await signedRequest(client, 'GET', '/v1/whoami', undefined, { signature: 'a'.repeat(64) })
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('Request signature is invalid')
  })

  it('refuses a request signed with the wrong secret', async () => {
    const res = await signedRequest({ id: client.id, secret: 'not-the-secret' }, 'GET', '/v1/whoami')
    expect(res.status).toBe(401)
  })

  it('refuses a body changed after signing', async () => {
    const nonce = newNonce()
    const timestamp = String(Math.floor(Date.now() / 1000))
    const { sign } = await import('../server/lib/signing')
    const signature = sign(client.secret, 'POST', '/api/v1/whoami', timestamp, nonce, '{"a":1}')
    const res = await signedRequest(client, 'POST', '/v1/whoami', { a: 2 }, { nonce, timestamp, signature })
    expect(res.status).toBe(401)
  })

  it('refuses a stale or future timestamp', async () => {
    const old = String(Math.floor(Date.now() / 1000) - 6 * 60)
    expect((await signedRequest(client, 'GET', '/v1/whoami', undefined, { timestamp: old })).status).toBe(401)
    const future = String(Math.floor(Date.now() / 1000) + 6 * 60)
    expect((await signedRequest(client, 'GET', '/v1/whoami', undefined, { timestamp: future })).status).toBe(401)
  })

  it('refuses a replayed nonce', async () => {
    const nonce = newNonce()
    expect((await signedRequest(client, 'GET', '/v1/whoami', undefined, { nonce })).status).toBe(200)
    const replay = await signedRequest(client, 'GET', '/v1/whoami', undefined, { nonce })
    expect(replay.status).toBe(401)
    expect(((await replay.json()) as { error: { message: string } }).error.message).toBe('Request was already used')
  })

  it('does not store nonces for unsigned requests', async () => {
    const nonce = newNonce()
    await signedRequest(client, 'GET', '/v1/whoami', undefined, { nonce, signature: 'b'.repeat(64) })
    expect(await db.select().from(requestNonces).where(eq(requestNonces.nonce, nonce))).toHaveLength(0)
  })

  it('refuses an unknown client and missing headers', async () => {
    const unknown = await signedRequest(client, 'GET', '/v1/whoami', undefined, { clientId: '00000000-0000-4000-8000-000000000000' })
    expect(unknown.status).toBe(401)
    const { app } = await import('../server/app')
    expect((await app.request('http://localhost/api/v1/whoami')).status).toBe(401)
  })

  it('refuses a revoked client', async () => {
    await revokeApiClient(client.id)
    expect((await signedRequest(client, 'GET', '/v1/whoami')).status).toBe(401)
  })

  it('after rotation only the new secret works', async () => {
    const { secret } = await rotateApiClientSecret(client.id)
    expect((await signedRequest(client, 'GET', '/v1/whoami')).status).toBe(401)
    expect((await signedRequest({ id: client.id, secret }, 'GET', '/v1/whoami')).status).toBe(200)
  })

  it('rate limits per client', async () => {
    const restore = overrideLimits({ client: { limit: 2, windowSec: 60 } })
    try {
      expect((await signedRequest(client, 'GET', '/v1/whoami')).status).toBe(200)
      expect((await signedRequest(client, 'GET', '/v1/whoami')).status).toBe(200)
      expect((await signedRequest(client, 'GET', '/v1/whoami')).status).toBe(429)
      // Another client has its own budget.
      const other = await createApiClient({ name: 'other', scopes: [], tenantIds: [] })
      expect((await signedRequest({ id: other.client.id, secret: other.secret }, 'GET', '/v1/whoami')).status).toBe(200)
    } finally {
      restore()
    }
  })
})
