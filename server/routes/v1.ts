import { zValidator } from '@hono/zod-validator'
import { eq } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { getDb } from '../db/client.js'
import { tenants } from '../db/schema.js'
import type { TenantScope } from '../db/tenantScope.js'
import { badRequest } from '../errors.js'
import { clientTenant, requireClient, requireScope, type ClientEnv } from '../middleware/clientAuth.js'
import { audit } from '../services/audit.js'
import { idempotencyKeyOf } from '../services/idempotency.js'
import { uploadMedia } from '../services/media.js'
import { cancelPost, createPost, createPostBody, getPostView, listPosts, listPostsQuery, reschedulePost, takeDownTarget } from '../services/posts.js'
import { accountView, listAccounts } from '../services/socialAccounts.js'
import { tenantsByIds } from '../services/tenants.js'

const publicTenant = (t: typeof tenants.$inferSelect) => ({ id: t.id, name: t.name, kind: t.kind, status: t.status })

/** Validation failures answer in the app's error shape, naming the first problem. */
const invalidInput = (result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }, c: Context) => {
  if (!result.success) {
    const issue = result.error?.issues[0]
    const where = issue?.path.length ? `${issue.path.map(String).join('.')}: ` : ''
    return c.json({ error: { code: 'BadRequest', message: `${where}${issue?.message ?? 'Invalid request'}` } }, 400)
  }
}

/**
 * The tenant a request acts for: `tenant_id` when given, otherwise the client's only tenant. A client linked to
 * several tenants must say which.
 */
async function tenantFor(c: Context<ClientEnv>, given: string | undefined): Promise<TenantScope> {
  const ids = c.get('client').tenantIds
  const tenantId = given ?? (ids.length === 1 ? ids[0] : undefined)
  if (!tenantId) throw badRequest('tenant_id is required for a client that acts for several tenants')
  return clientTenant(c, tenantId)
}

const tenantQuery = z.object({ tenant_id: z.uuid().optional() })
const postParam = z.object({ id: z.uuid() })
const targetParam = z.object({ id: z.uuid(), targetId: z.uuid() })
const rescheduleBody = z.object({ scheduled_for: z.iso.datetime({ offset: true }).nullable() })

const clientActor = (c: Context<ClientEnv>, scope: TenantScope) => ({ actorType: 'client' as const, actorId: c.get('client').id, tenantId: scope.tenantId })

/** The signed API for client apps (docs/integration-open-play.md). Every route requires a signed request. */
export const v1Route = new Hono<ClientEnv>()
  .use('*', requireClient)
  .get('/whoami', async (c) => {
    const client = c.get('client')
    const list = await tenantsByIds(client.tenantIds)
    return c.json({
      client: { id: client.id, name: client.name, scopes: client.scopes },
      tenants: list.map(publicTenant),
    })
  })
  .get('/tenants/:tenantId', async (c) => {
    const scope = await clientTenant(c, c.req.param('tenantId'))
    const [tenant] = await getDb().select().from(tenants).where(eq(tenants.id, scope.tenantId))
    return c.json(publicTenant(tenant!))
  })
  .get('/accounts', zValidator('query', tenantQuery, invalidInput), async (c) => {
    requireScope(c, 'accounts:read')
    const scope = await tenantFor(c, c.req.valid('query').tenant_id)
    const accounts = await listAccounts(scope)
    return c.json({
      accounts: accounts.map((a) => {
        const { last_error: _e, last_checked_at: _l, ...view } = accountView(a)
        return view
      }),
    })
  })
  // Raw image bytes; the body limit for this path is set in app.ts.
  .post('/media', zValidator('query', tenantQuery, invalidInput), async (c) => {
    requireScope(c, 'media:write')
    const scope = await tenantFor(c, c.req.valid('query').tenant_id)
    const key = idempotencyKeyOf(c)
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (bytes.length === 0) throw badRequest('Send the image bytes as the request body')
    const result = await uploadMedia(scope, c.get('client').id, key, bytes)
    return c.json(result.body as object, result.status as 200 | 201)
  })
  .post('/posts', zValidator('json', createPostBody, invalidInput), async (c) => {
    requireScope(c, 'posts:write')
    const input = c.req.valid('json')
    const scope = await tenantFor(c, input.tenant_id)
    const key = idempotencyKeyOf(c)
    const { status, post, replayed } = await createPost(scope, c.get('client').id, key, input)
    if (!replayed) await audit({ ...clientActor(c, scope), action: 'post.created', targetType: 'post', targetId: post.id, details: { source: post.source } })
    return c.json(post, status as 200 | 201)
  })
  .get('/posts', zValidator('query', listPostsQuery, invalidInput), async (c) => {
    requireScope(c, 'posts:read')
    const q = c.req.valid('query')
    const scope = await tenantFor(c, q.tenant_id)
    return c.json({ posts: await listPosts(scope, q) })
  })
  .get('/posts/:id', zValidator('param', postParam, invalidInput), zValidator('query', tenantQuery, invalidInput), async (c) => {
    requireScope(c, 'posts:read')
    const scope = await tenantFor(c, c.req.valid('query').tenant_id)
    return c.json(await getPostView(scope, c.req.valid('param').id, { attempts: true }))
  })
  .post('/posts/:id/cancel', zValidator('param', postParam, invalidInput), zValidator('query', tenantQuery, invalidInput), async (c) => {
    requireScope(c, 'posts:write')
    const scope = await tenantFor(c, c.req.valid('query').tenant_id)
    const post = await cancelPost(scope, c.req.valid('param').id)
    await audit({ ...clientActor(c, scope), action: 'post.cancelled', targetType: 'post', targetId: post.id })
    return c.json(post)
  })
  .post(
    '/posts/:id/reschedule',
    zValidator('param', postParam, invalidInput),
    zValidator('query', tenantQuery, invalidInput),
    zValidator('json', rescheduleBody, invalidInput),
    async (c) => {
      requireScope(c, 'posts:write')
      const scope = await tenantFor(c, c.req.valid('query').tenant_id)
      const when = c.req.valid('json').scheduled_for
      const post = await reschedulePost(scope, c.req.valid('param').id, when ? new Date(when) : null)
      await audit({ ...clientActor(c, scope), action: 'post.rescheduled', targetType: 'post', targetId: post.id, details: { scheduled_for: when } })
      return c.json(post)
    },
  )
  .delete('/posts/:id/targets/:targetId', zValidator('param', targetParam, invalidInput), zValidator('query', tenantQuery, invalidInput), async (c) => {
    requireScope(c, 'posts:write')
    const scope = await tenantFor(c, c.req.valid('query').tenant_id)
    const { id, targetId } = c.req.valid('param')
    const post = await takeDownTarget(scope, id, targetId)
    await audit({ ...clientActor(c, scope), action: 'post.taken_down', targetType: 'post_target', targetId })
    return c.json(post)
  })
