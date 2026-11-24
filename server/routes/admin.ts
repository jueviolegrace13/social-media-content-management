import { zValidator } from '@hono/zod-validator'
import { Hono, type Context } from 'hono'
import { desc } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/client.js'
import { API_SCOPES, auditLog, TENANT_KINDS } from '../db/schema.js'
import { tooManyRequests, unauthorized } from '../errors.js'
import { clearAdminSession, requireAdmin, setAdminCookie, type AdminEnv } from '../middleware/adminAuth.js'
import { createAdminSession, verifyAdminCredentials } from '../services/admins.js'
import { createApiClient, listApiClients, revokeApiClient, rotateApiClientSecret } from '../services/apiClients.js'
import { audit } from '../services/audit.js'
import { bump, clientIp, consume, count, LIMITS } from '../services/rateLimit.js'
import { createTenant, listTenants, setTenantStatus } from '../services/tenants.js'

const signInBody = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(256),
  code: z.string().trim().regex(/^\d{6}$/),
})

const tenantBody = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(TENANT_KINDS),
  externalRef: z.string().trim().max(120).nullish(),
})

const tenantStatusBody = z.object({ status: z.enum(['active', 'suspended']) })

const clientBody = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'Use lowercase letters, digits and dashes'),
  scopes: z.array(z.enum(API_SCOPES)).max(API_SCOPES.length),
  tenantIds: z.array(z.uuid()).max(100),
  webhookUrl: z.url({ protocol: /^https$/ }).max(2048).nullish(),
})

const uuidParam = z.object({ id: z.uuid() })

/** Validation failures answer in the app's error shape. */
const invalidInput = (result: { success: boolean }, c: Context) => {
  if (!result.success) return c.json({ error: { code: 'BadRequest', message: 'Check the form and try again' } }, 400)
}

function actor(c: Context<AdminEnv>) {
  return { actorType: 'admin' as const, actorId: c.get('admin').id, ip: clientIp(c) }
}

const authRoute = new Hono()
  .post('/sign-in', zValidator('json', signInBody, invalidInput), async (c) => {
    const { email, password, code } = c.req.valid('json')
    const ip = clientIp(c) ?? 'unknown'
    const emailKey = email.toLowerCase()
    await consume('adminSignInIp', ip)
    if ((await count('adminSignInEmail', emailKey)) >= LIMITS.adminSignInEmail.limit) throw tooManyRequests()
    const admin = await verifyAdminCredentials(email, password, code)
    if (!admin) {
      await bump('adminSignInEmail', emailKey)
      await audit({ actorType: 'system', action: 'admin.sign_in_failed', details: { email: emailKey }, ip: clientIp(c) })
      throw unauthorized('Email, password or code is incorrect')
    }
    setAdminCookie(c, await createAdminSession(admin.id))
    await audit({ actorType: 'admin', actorId: admin.id, action: 'admin.signed_in', ip: clientIp(c) })
    return c.json({ admin })
  })
  .post('/sign-out', async (c) => {
    await clearAdminSession(c)
    return c.json({ ok: true })
  })

const managedRoute = new Hono<AdminEnv>()
  .use('*', requireAdmin)
  .get('/me', (c) => c.json({ admin: c.get('admin') }))
  .get('/tenants', async (c) => c.json({ tenants: await listTenants() }))
  .post('/tenants', zValidator('json', tenantBody, invalidInput), async (c) => {
    const tenant = await createTenant(c.req.valid('json'))
    await audit({ ...actor(c), tenantId: tenant.id, action: 'tenant.created', targetType: 'tenant', targetId: tenant.id, details: { name: tenant.name, kind: tenant.kind } })
    return c.json({ tenant }, 201)
  })
  .post('/tenants/:id/status', zValidator('param', uuidParam, invalidInput), zValidator('json', tenantStatusBody, invalidInput), async (c) => {
    const { id } = c.req.valid('param')
    const tenant = await setTenantStatus(id, c.req.valid('json').status)
    await audit({ ...actor(c), tenantId: id, action: `tenant.${tenant.status}`, targetType: 'tenant', targetId: id })
    return c.json({ tenant })
  })
  .get('/clients', async (c) => c.json({ clients: await listApiClients() }))
  .post('/clients', zValidator('json', clientBody, invalidInput), async (c) => {
    const { client, secret } = await createApiClient(c.req.valid('json'))
    await audit({
      ...actor(c),
      action: 'api_client.created',
      targetType: 'api_client',
      targetId: client.id,
      details: { name: client.name, scopes: client.scopes, tenantIds: client.tenantIds },
    })
    // The secret is returned this once and never again.
    return c.json({ client, secret }, 201)
  })
  .post('/clients/:id/rotate', zValidator('param', uuidParam, invalidInput), async (c) => {
    const { client, secret } = await rotateApiClientSecret(c.req.valid('param').id)
    await audit({ ...actor(c), action: 'api_client.secret_rotated', targetType: 'api_client', targetId: client.id })
    return c.json({ client, secret })
  })
  .post('/clients/:id/revoke', zValidator('param', uuidParam, invalidInput), async (c) => {
    const client = await revokeApiClient(c.req.valid('param').id)
    await audit({ ...actor(c), action: 'api_client.revoked', targetType: 'api_client', targetId: client.id })
    return c.json({ client })
  })
  .get('/audit', async (c) => {
    const entries = await getDb().select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(100)
    return c.json({ entries })
  })

export const adminRoute = new Hono().route('/auth', authRoute).route('/', managedRoute)
