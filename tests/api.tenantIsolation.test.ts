import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../server/db/client'
import { auditLog } from '../server/db/schema'
import { forTenant } from '../server/db/tenantScope'
import { createApiClient } from '../server/services/apiClients'
import { createTenant, setTenantStatus } from '../server/services/tenants'
import { signedRequest, useTestDb } from './helpers'

let db: Db
let close: () => Promise<void>
let tenantA: string
let tenantB: string

beforeEach(async () => {
  ;({ db, close } = await useTestDb())
  tenantA = (await createTenant({ name: 'Club A', kind: 'club' })).id
  tenantB = (await createTenant({ name: 'Club B', kind: 'club' })).id
})

afterEach(async () => {
  await close()
})

describe('tenant-scoped helper', () => {
  it('reads only its own tenant rows, whatever the caller filters on', async () => {
    await forTenant(db, tenantA).insert(auditLog, { actorType: 'system', action: 'a.thing' })
    const [bRow] = await forTenant(db, tenantB).insert(auditLog, { actorType: 'system', action: 'b.thing' })

    const asA = forTenant(db, tenantA)
    expect((await asA.select(auditLog)).map((r) => r.action)).toEqual(['a.thing'])
    // Asking for B's row by ID through A's scope finds nothing.
    expect(await asA.select(auditLog, eq(auditLog.id, bRow!.id))).toEqual([])
  })

  it("can't update or delete another tenant's rows", async () => {
    const [bRow] = await forTenant(db, tenantB).insert(auditLog, { actorType: 'system', action: 'b.thing' })
    const asA = forTenant(db, tenantA)
    expect(await asA.update(auditLog, { action: 'hijacked' }, eq(auditLog.id, bRow!.id))).toEqual([])
    expect(await asA.delete(auditLog, eq(auditLog.id, bRow!.id))).toEqual([])
    const [still] = await db.select().from(auditLog).where(eq(auditLog.id, bRow!.id))
    expect(still!.action).toBe('b.thing')
  })

  it('inserts always carry the scope tenant and updates never move rows', async () => {
    const asA = forTenant(db, tenantA)
    const [row] = await asA.insert(auditLog, { actorType: 'system', action: 'x', tenantId: tenantB } as never)
    expect(row!.tenantId).toBe(tenantA)
    const [moved] = await asA.update(auditLog, { tenantId: tenantB, action: 'y' }, eq(auditLog.id, row!.id))
    expect(moved!.tenantId).toBe(tenantA)
  })

  it('requires a tenant', () => {
    expect(() => forTenant(db, '')).toThrow()
  })
})

describe('client tenant access over the API', () => {
  it('a client may act for its own tenant only', async () => {
    const created = await createApiClient({ name: 'club-a-app', scopes: [], tenantIds: [tenantA] })
    const client = { id: created.client.id, secret: created.secret }

    expect((await signedRequest(client, 'GET', `/v1/tenants/${tenantA}`)).status).toBe(200)
    expect((await signedRequest(client, 'GET', `/v1/tenants/${tenantB}`)).status).toBe(403)
    expect((await signedRequest(client, 'GET', '/v1/tenants/not-a-uuid')).status).toBe(403)

    const whoami = (await (await signedRequest(client, 'GET', '/v1/whoami')).json()) as { tenants: { id: string }[] }
    expect(whoami.tenants.map((t) => t.id)).toEqual([tenantA])
  })

  it('a suspended tenant is refused', async () => {
    const created = await createApiClient({ name: 'club-a-app', scopes: [], tenantIds: [tenantA] })
    await setTenantStatus(tenantA, 'suspended')
    expect((await signedRequest({ id: created.client.id, secret: created.secret }, 'GET', `/v1/tenants/${tenantA}`)).status).toBe(403)
  })
})
