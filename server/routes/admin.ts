import { zValidator } from '@hono/zod-validator'
import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../db/client.js'
import { API_SCOPES, auditLog, POST_STATUSES, posts, TENANT_KINDS } from '../db/schema.js'
import { forTenant } from '../db/tenantScope.js'
import { notFound, tooManyRequests, unauthorized } from '../errors.js'
import { clearAdminSession, requireAdmin, setAdminCookie, type AdminEnv } from '../middleware/adminAuth.js'
import { createAdminSession, verifyAdminCredentials } from '../services/admins.js'
import { createApiClient, listApiClients, revokeApiClient, rotateApiClientSecret, setApiClientWebhook } from '../services/apiClients.js'
import { finishLogin, LOGIN_TTL_MINUTES, pendingLogin, redirectUri, selectPage, startLogin } from '../services/facebookLogin.js'
import { getPostView, postViews, retryTarget } from '../services/posts.js'
import { accountView, checkAccount, disconnectAccount, findAccount, listAllAccounts } from '../services/socialAccounts.js'
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
const webhookBody = z.object({ webhookUrl: z.url({ protocol: /^https$/ }).max(2048).nullable() })
const connectQuery = z.object({ tenantId: z.uuid() })
const selectPageBody = z.object({ pageId: z.string().regex(/^\d{1,30}$/) })
const postsQuery = z.object({ status: z.enum(POST_STATUSES).optional(), tenantId: z.uuid().optional() })
const targetParam = z.object({ id: z.uuid(), targetId: z.uuid() })

/** Browser-bound copy of the Facebook Login state; Lax so it comes back on Facebook's redirect. */
const STATE_COOKIE = 'fb_login_state'
const STATE_COOKIE_PATH = '/api/admin/accounts/facebook/callback'
const isHttps = (c: Context) => new URL(c.req.url).protocol === 'https:'

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

/**
 * Facebook's redirect back after login. Public: the SameSite=Strict admin cookie isn't sent on a cross-site
 * redirect, so this route trusts only the stored state and the state cookie, and the admin picks the Page next in
 * a signed-in call. Answers by redirecting into the admin UI.
 */
const facebookCallbackRoute = new Hono().get('/accounts/facebook/callback', async (c) => {
  const cookieState = getCookie(c, STATE_COOKIE) ?? ''
  deleteCookie(c, STATE_COOKIE, { path: STATE_COOKIE_PATH, secure: isHttps(c) })
  const state = c.req.query('state') ?? ''
  const code = c.req.query('code') ?? ''
  if (c.req.query('error') || !code) return c.redirect('/admin/accounts?connect_error=cancelled')
  try {
    const id = await finishLogin({ state, cookieState, code, redirect: redirectUri(c.req.url) })
    return c.redirect(`/admin/accounts?connect=${id}`)
  } catch (error) {
    console.error('Facebook Login failed', error instanceof Error ? error.message : error)
    return c.redirect('/admin/accounts?connect_error=failed')
  }
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
    const { client, secret, webhookSecret } = await createApiClient(c.req.valid('json'))
    await audit({
      ...actor(c),
      action: 'api_client.created',
      targetType: 'api_client',
      targetId: client.id,
      details: { name: client.name, scopes: client.scopes, tenantIds: client.tenantIds },
    })
    // The secrets are returned this once and never again.
    return c.json({ client, secret, webhookSecret }, 201)
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
  .post('/clients/:id/webhook', zValidator('param', uuidParam, invalidInput), zValidator('json', webhookBody, invalidInput), async (c) => {
    const { client, webhookSecret } = await setApiClientWebhook(c.req.valid('param').id, c.req.valid('json').webhookUrl)
    await audit({ ...actor(c), action: 'api_client.webhook_set', targetType: 'api_client', targetId: client.id, details: { webhookUrl: client.webhookUrl } })
    // The webhook secret is returned this once and never again.
    return c.json({ client, webhookSecret })
  })
  // Social accounts (FR-2, FR-7.2)
  .get('/accounts', async (c) => c.json({ accounts: (await listAllAccounts()).map(accountView) }))
  .get('/accounts/facebook/connect', zValidator('query', connectQuery, invalidInput), async (c) => {
    const { tenantId } = c.req.valid('query')
    const { url, state } = await startLogin(c.get('admin').id, tenantId, redirectUri(c.req.url))
    setCookie(c, STATE_COOKIE, state, { httpOnly: true, secure: isHttps(c), sameSite: 'Lax', path: STATE_COOKIE_PATH, maxAge: LOGIN_TTL_MINUTES * 60 })
    return c.redirect(url)
  })
  .get('/accounts/facebook/pending/:id', zValidator('param', uuidParam, invalidInput), async (c) =>
    c.json(await pendingLogin(c.req.valid('param').id, c.get('admin').id)),
  )
  .post('/accounts/facebook/pending/:id/select', zValidator('param', uuidParam, invalidInput), zValidator('json', selectPageBody, invalidInput), async (c) => {
    const account = await selectPage(c.req.valid('param').id, c.get('admin').id, c.req.valid('json').pageId)
    await audit({ ...actor(c), tenantId: account.tenantId, action: 'account.connected', targetType: 'social_account', targetId: account.id, details: { network: account.network, name: account.name } })
    return c.json({ account: accountView(account) })
  })
  .post('/accounts/:id/check', zValidator('param', uuidParam, invalidInput), async (c) => {
    const account = await findAccount(c.req.valid('param').id)
    if (!account) throw notFound('Account')
    return c.json({ account: accountView(await checkAccount(account)) })
  })
  .post('/accounts/:id/disconnect', zValidator('param', uuidParam, invalidInput), async (c) => {
    const found = await findAccount(c.req.valid('param').id)
    if (!found) throw notFound('Account')
    const account = await disconnectAccount(forTenant(getDb(), found.tenantId), found.id)
    await audit({ ...actor(c), tenantId: account.tenantId, action: 'account.disconnected', targetType: 'social_account', targetId: account.id })
    return c.json({ account: accountView(account) })
  })
  // Publishing history (FR-6, FR-7.2)
  .get('/posts', zValidator('query', postsQuery, invalidInput), async (c) => {
    const { status, tenantId } = c.req.valid('query')
    const where = and(status ? eq(posts.status, status) : undefined, tenantId ? eq(posts.tenantId, tenantId) : undefined)
    const rows = await getDb().select().from(posts).where(where).orderBy(desc(posts.createdAt)).limit(50)
    // Views are built per tenant, through each tenant's own scope.
    const byTenant = new Map<string, typeof rows>()
    for (const row of rows) byTenant.set(row.tenantId, [...(byTenant.get(row.tenantId) ?? []), row])
    const views = (await Promise.all([...byTenant].map(([id, list]) => postViews(forTenant(getDb(), id), list)))).flat()
    views.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    return c.json({ posts: views })
  })
  .get('/posts/:id', zValidator('param', uuidParam, invalidInput), async (c) => {
    const [row] = await getDb().select().from(posts).where(eq(posts.id, c.req.valid('param').id))
    if (!row) throw notFound('Post')
    return c.json({ post: await getPostView(forTenant(getDb(), row.tenantId), row.id, { attempts: true }) })
  })
  .post('/posts/:id/targets/:targetId/retry', zValidator('param', targetParam, invalidInput), async (c) => {
    const { id, targetId } = c.req.valid('param')
    const [row] = await getDb().select().from(posts).where(eq(posts.id, id))
    if (!row) throw notFound('Post')
    const post = await retryTarget(forTenant(getDb(), row.tenantId), id, targetId)
    await audit({ ...actor(c), tenantId: row.tenantId, action: 'post.target_retried', targetType: 'post_target', targetId })
    return c.json({ post })
  })
  .get('/audit', async (c) => {
    const entries = await getDb().select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(100)
    return c.json({ entries })
  })

export const adminRoute = new Hono().route('/auth', authRoute).route('/', facebookCallbackRoute).route('/', managedRoute)
