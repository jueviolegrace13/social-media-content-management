import { Hono } from 'hono'
import { clientTenant, requireClient, type ClientEnv } from '../middleware/clientAuth.js'
import { tenants } from '../db/schema.js'
import { getDb } from '../db/client.js'
import { eq } from 'drizzle-orm'
import { tenantsByIds } from '../services/tenants.js'

const publicTenant = (t: typeof tenants.$inferSelect) => ({ id: t.id, name: t.name, kind: t.kind, status: t.status })

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
