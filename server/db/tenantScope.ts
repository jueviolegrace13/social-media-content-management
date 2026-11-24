import { and, eq, type SQL } from 'drizzle-orm'
import type { PgColumn, PgTable, PgUpdateSetSource } from 'drizzle-orm/pg-core'
import type { Db } from './client.js'

/**
 * The only way to read or write a tenant's rows. Every statement built here carries `tenant_id = <tenant>`,
 * so a query for one tenant can't see or change another tenant's data, whatever the caller's own filter says.
 * Code that isn't tenant-owned (tenants, api_clients, admin tables) uses the plain db handle.
 */

type TenantTable = PgTable & { tenantId: PgColumn }

export interface TenantScope {
  readonly tenantId: string
  select<T extends TenantTable>(table: T, where?: SQL): Promise<T['$inferSelect'][]>
  insert<T extends TenantTable>(table: T, values: Omit<T['$inferInsert'], 'tenantId'>): Promise<T['$inferSelect'][]>
  update<T extends TenantTable>(table: T, set: PgUpdateSetSource<T>, where?: SQL): Promise<T['$inferSelect'][]>
  delete<T extends TenantTable>(table: T, where?: SQL): Promise<T['$inferSelect'][]>
}

export function forTenant(db: Db, tenantId: string): TenantScope {
  if (!tenantId) throw new Error('A tenant is required')
  const scoped = (table: TenantTable, where?: SQL) => and(eq(table.tenantId, tenantId), where)
  // Drizzle's builder generics don't follow a generic table parameter, so the builders are typed loosely here
  // and the public signatures above carry the real types.
  const loose = db as unknown as {
    select: () => { from: (t: PgTable) => { where: (w: SQL | undefined) => Promise<unknown[]> } }
    insert: (t: PgTable) => { values: (v: unknown) => { returning: () => Promise<unknown[]> } }
    update: (t: PgTable) => { set: (s: unknown) => { where: (w: SQL | undefined) => { returning: () => Promise<unknown[]> } } }
    delete: (t: PgTable) => { where: (w: SQL | undefined) => { returning: () => Promise<unknown[]> } }
  }
  return {
    tenantId,
    select: (table, where) => loose.select().from(table).where(scoped(table, where)) as never,
    insert: (table, values) => loose.insert(table).values({ ...values, tenantId }).returning() as never,
    update: (table, set, where) => {
      // The tenant of a row never changes through a scope.
      const { tenantId: _ignored, ...rest } = set as Record<string, unknown>
      return loose.update(table).set(rest).where(scoped(table, where)).returning() as never
    },
    delete: (table, where) => loose.delete(table).where(scoped(table, where)).returning() as never,
  }
}
