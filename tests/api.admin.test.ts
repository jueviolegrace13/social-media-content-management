import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../server/db/client'
import { adminUsers, auditLog } from '../server/db/schema'
import { timeStep, totpAt } from '../server/lib/totp'
import { createAdmin } from '../server/services/admins'
import { overrideLimits } from '../server/services/rateLimit'
import { ADMIN_PASSWORD, adminClient, signedInAdmin, signedRequest, useTestDb } from './helpers'

let db: Db
let close: () => Promise<void>

beforeEach(async () => {
  ;({ db, close } = await useTestDb())
})

afterEach(async () => {
  await close()
})

describe('admin sign-in', () => {
  it('needs password and TOTP, and sets a hardened session cookie', async () => {
    const { totpSecret } = await createAdmin('Root@Example.com', ADMIN_PASSWORD)
    const code = totpAt(totpSecret, timeStep())
    const res = await adminClient().request('POST', '/auth/sign-in', { email: 'root@example.com', password: ADMIN_PASSWORD, code })
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toMatch(/^admin_session=/)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Path=/api/admin')
    const me = await adminClient(cookie.split(';')[0]).request('GET', '/me')
    expect(((await me.json()) as { admin: { email: string } }).admin.email).toBe('root@example.com')
  })

  it('marks the cookie Secure over https', async () => {
    const { totpSecret } = await createAdmin('root@example.com', ADMIN_PASSWORD)
    const { app } = await import('../server/app')
    const res = await app.request('https://social.example/api/admin/auth/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'root@example.com', password: ADMIN_PASSWORD, code: totpAt(totpSecret, timeStep()) }),
    })
    expect(res.headers.get('set-cookie')).toContain('Secure')
  })

  it('stores the TOTP secret encrypted', async () => {
    const { admin, totpSecret } = await createAdmin('root@example.com', ADMIN_PASSWORD)
    const [row] = await db.select().from(adminUsers).where(eq(adminUsers.id, admin.id))
    expect(JSON.stringify(row)).not.toContain(totpSecret)
    expect(row!.passwordHash).not.toContain(ADMIN_PASSWORD)
  })

  it('refuses a wrong password, wrong code, unknown email and a reused code', async () => {
    const { totpSecret } = await createAdmin('root@example.com', ADMIN_PASSWORD)
    const code = totpAt(totpSecret, timeStep())
    const signIn = (body: object) => adminClient().request('POST', '/auth/sign-in', body)
    expect((await signIn({ email: 'root@example.com', password: 'wrong-password-123', code })).status).toBe(401)
    expect((await signIn({ email: 'root@example.com', password: ADMIN_PASSWORD, code: code === '000000' ? '111111' : '000000' })).status).toBe(401)
    expect((await signIn({ email: 'nobody@example.com', password: ADMIN_PASSWORD, code })).status).toBe(401)
    expect((await signIn({ email: 'root@example.com', password: ADMIN_PASSWORD, code })).status).toBe(200)
    expect((await signIn({ email: 'root@example.com', password: ADMIN_PASSWORD, code })).status).toBe(401)
    const failures = await db.select().from(auditLog).where(eq(auditLog.action, 'admin.sign_in_failed'))
    expect(failures.length).toBeGreaterThanOrEqual(3)
  })

  it('locks an email out after repeated failures', async () => {
    const restore = overrideLimits({ adminSignInEmail: { limit: 2, windowSec: 900 } })
    try {
      const { totpSecret } = await createAdmin('root@example.com', ADMIN_PASSWORD)
      const signIn = (password: string) =>
        adminClient().request('POST', '/auth/sign-in', { email: 'root@example.com', password, code: totpAt(totpSecret, timeStep()) })
      expect((await signIn('wrong-password-123')).status).toBe(401)
      expect((await signIn('wrong-password-123')).status).toBe(401)
      // Even the right password is refused until the window passes.
      expect((await signIn(ADMIN_PASSWORD)).status).toBe(429)
    } finally {
      restore()
    }
  })

  it('sign-out ends the session', async () => {
    const { admin } = await signedInAdmin()
    expect((await admin.request('POST', '/auth/sign-out')).status).toBe(200)
    expect((await admin.request('GET', '/me')).status).toBe(401)
  })

  it('admin routes need a session', async () => {
    expect((await adminClient().request('GET', '/tenants')).status).toBe(401)
    expect((await adminClient('admin_session=forged').request('GET', '/clients')).status).toBe(401)
  })

  it('refuses cross-site writes', async () => {
    const { admin } = await signedInAdmin()
    const res = await admin.request('POST', '/tenants', { name: 'X', kind: 'club' }, { origin: 'https://evil.example' })
    expect(res.status).toBe(403)
  })
})

describe('admin management', () => {
  it('creates tenants and API clients, shows the secret once, rotates and revokes, all audited', async () => {
    const { admin } = await signedInAdmin()

    const tenantRes = await admin.request('POST', '/tenants', { name: 'Open Play platform', kind: 'platform' })
    expect(tenantRes.status).toBe(201)
    const { tenant } = (await tenantRes.json()) as { tenant: { id: string } }

    const createRes = await admin.request('POST', '/clients', { name: 'open-play', scopes: ['posts:write'], tenantIds: [tenant.id] })
    expect(createRes.status).toBe(201)
    const created = (await createRes.json()) as { client: { id: string }; secret: string }
    expect(created.secret.length).toBeGreaterThanOrEqual(40)

    // Listing never includes the secret.
    const list = await (await admin.request('GET', '/clients')).text()
    expect(list).toContain('open-play')
    expect(list).not.toContain(created.secret)
    expect(list).not.toContain('Ciphertext')

    const client = { id: created.client.id, secret: created.secret }
    expect((await signedRequest(client, 'GET', '/v1/whoami')).status).toBe(200)

    const rotated = (await (await admin.request('POST', `/clients/${client.id}/rotate`)).json()) as { secret: string }
    expect(rotated.secret).not.toBe(created.secret)
    expect((await signedRequest({ id: client.id, secret: rotated.secret }, 'GET', '/v1/whoami')).status).toBe(200)

    expect((await admin.request('POST', `/clients/${client.id}/revoke`)).status).toBe(200)
    expect((await signedRequest({ id: client.id, secret: rotated.secret }, 'GET', '/v1/whoami')).status).toBe(401)
    // Revoked clients can't be rotated back to life.
    expect((await admin.request('POST', `/clients/${client.id}/rotate`)).status).toBe(404)

    const actions = (await db.select().from(auditLog)).map((e) => e.action)
    expect(actions).toEqual(
      expect.arrayContaining(['admin.signed_in', 'tenant.created', 'api_client.created', 'api_client.secret_rotated', 'api_client.revoked']),
    )
    // No secret ever lands in the audit log.
    const auditText = JSON.stringify(await db.select().from(auditLog))
    expect(auditText).not.toContain(created.secret)
    expect(auditText).not.toContain(rotated.secret)
  })

  it('validates input', async () => {
    const { admin } = await signedInAdmin()
    expect((await admin.request('POST', '/clients', { name: 'Bad Name', scopes: [], tenantIds: [] })).status).toBe(400)
    expect((await admin.request('POST', '/clients', { name: 'ok', scopes: ['everything'], tenantIds: [] })).status).toBe(400)
    expect((await admin.request('POST', '/clients', { name: 'ok', scopes: [], tenantIds: ['00000000-0000-4000-8000-000000000000'] })).status).toBe(400)
    expect((await admin.request('POST', '/tenants', { name: '', kind: 'club' })).status).toBe(400)
    expect((await admin.request('POST', '/clients/not-a-uuid/revoke')).status).toBe(400)
  })
})
