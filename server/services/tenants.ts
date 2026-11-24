import { asc, eq, inArray } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { tenants, type TENANT_KINDS } from '../db/schema.js'
import { notFound } from '../errors.js'

export type TenantKind = (typeof TENANT_KINDS)[number]
export type Tenant = typeof tenants.$inferSelect

export async function listTenants(): Promise<Tenant[]> {
  return getDb().select().from(tenants).orderBy(asc(tenants.name))
}

export async function tenantsByIds(ids: string[]): Promise<Tenant[]> {
  if (ids.length === 0) return []
  return getDb().select().from(tenants).where(inArray(tenants.id, ids)).orderBy(asc(tenants.name))
}

export async function createTenant(input: { name: string; kind: TenantKind; externalRef?: string | null }): Promise<Tenant> {
  const [row] = await getDb()
    .insert(tenants)
    .values({ name: input.name, kind: input.kind, externalRef: input.externalRef ?? null })
    .returning()
  return row!
}

export async function setTenantStatus(id: string, status: 'active' | 'suspended'): Promise<Tenant> {
  const [row] = await getDb().update(tenants).set({ status }).where(eq(tenants.id, id)).returning()
  if (!row) throw notFound('Tenant')
  return row
}
