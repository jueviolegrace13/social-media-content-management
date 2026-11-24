import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app, MAX_BODY_BYTES } from '../server/app'
import type { Db } from '../server/db/client'
import { requestNonces } from '../server/db/schema'
import { cleanup } from '../server/routes/cron'
import { createApiClient } from '../server/services/apiClients'
import { signedRequest, useTestDb } from './helpers'

let db: Db
let close: () => Promise<void>

beforeEach(async () => {
  ;({ db, close } = await useTestDb())
})

afterEach(async () => {
  await close()
})

describe('security headers', () => {
  it('API responses, errors included, carry hardening headers', async () => {
    for (const path of ['/api/health', '/api/nope', '/api/v1/whoami']) {
      const res = await app.request(`http://localhost${path}`)
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('x-frame-options')).toBe('DENY')
      expect(res.headers.get('strict-transport-security')).toBe('max-age=63072000; includeSubDomains')
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    }
  })

  it('vercel.json covers the static app', () => {
    const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as { headers?: { source: string; headers: { key: string; value: string }[] }[] }
    const entry = config.headers?.find((h) => h.source === '/((?!api/).*)')
    const get = (key: string) => entry?.headers.find((h) => h.key === key)?.value
    expect(get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
    expect(get('Content-Security-Policy')).toContain("default-src 'self'")
    expect(get('Strict-Transport-Security')).toBe('max-age=63072000; includeSubDomains')
    expect(get('X-Frame-Options')).toBe('DENY')
  })
})

describe('CORS', () => {
  it('allows only the own origin', async () => {
    const preflight = (origin: string) =>
      app.request('http://localhost/api/admin/tenants', {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST' },
      })
    expect((await preflight('https://evil.example')).headers.get('access-control-allow-origin')).toBeNull()
    expect((await preflight('http://localhost')).headers.get('access-control-allow-origin')).toBe('http://localhost')
  })
})

describe('request size limit', () => {
  it('refuses oversized bodies', async () => {
    const res = await app.request('http://localhost/api/admin/auth/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'x'.repeat(MAX_BODY_BYTES + 10) }),
    })
    expect(res.status).toBe(413)
  })
})

describe('cleanup cron', () => {
  it('needs the cron secret', async () => {
    process.env.CRON_SECRET = 'cron-test-secret'
    expect((await app.request('http://localhost/api/cron/cleanup')).status).toBe(401)
    const ok = await app.request('http://localhost/api/cron/cleanup', { headers: { authorization: 'Bearer cron-test-secret' } })
    expect(ok.status).toBe(200)
  })

  it('purges old nonces only', async () => {
    const created = await createApiClient({ name: 'c', scopes: [], tenantIds: [] })
    await signedRequest({ id: created.client.id, secret: created.secret }, 'GET', '/v1/whoami')
    await db.insert(requestNonces).values({ clientId: created.client.id, nonce: 'old-nonce-0000000000', createdAt: new Date(Date.now() - 11 * 60_000) })
    const result = await cleanup()
    expect(result.nonces).toBe(1)
    expect(await db.select().from(requestNonces)).toHaveLength(1)
  })
})
