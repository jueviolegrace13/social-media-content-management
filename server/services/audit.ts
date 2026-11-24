import { getDb } from '../db/client.js'
import { auditLog } from '../db/schema.js'

export interface AuditEntry {
  actorType: 'admin' | 'client' | 'system'
  actorId?: string | null
  tenantId?: string | null
  action: string
  targetType?: string
  targetId?: string
  /** Never put secrets or tokens here. */
  details?: Record<string, unknown>
  ip?: string | null
}

export async function audit(entry: AuditEntry): Promise<void> {
  await getDb()
    .insert(auditLog)
    .values({
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      tenantId: entry.tenantId ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      details: entry.details ?? null,
      ip: entry.ip ?? null,
    })
}
