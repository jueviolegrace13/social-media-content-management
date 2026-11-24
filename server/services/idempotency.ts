import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { getDb } from '../db/client.js'
import { idempotencyKeys } from '../db/schema.js'
import { badRequest, conflict } from '../errors.js'
import { sha256Hex } from '../lib/signing.js'

/**
 * Idempotency keys (ADR-0010): per client, kept 7 days. Same key and same request returns the original result;
 * same key with a different request is a 409. The key row is written in the same SQL statement that creates the
 * resource, so a key never exists without its resource and a resource never exists without its key.
 */

const KEY_PATTERN = /^[\x21-\x7e]{1,200}$/

export function idempotencyKeyOf(c: Context): string {
  const key = c.req.header('idempotency-key') ?? ''
  if (!KEY_PATTERN.test(key)) throw badRequest('Send an Idempotency-Key header (1 to 200 visible ASCII characters)')
  return key
}

/** The request fingerprint: which operation, for which tenant, with what body. */
export function requestHash(operation: string, tenantId: string, body: string | Uint8Array): string {
  return sha256Hex(`${operation}\n${tenantId}\n${sha256Hex(body)}`)
}

export interface StoredResult {
  status: number
  body: unknown
}

/** The stored result for this key, null when the key is new, or a 409 when the key was used for another request. */
export async function previousResult(clientId: string, key: string, hash: string): Promise<StoredResult | null> {
  const [row] = await getDb()
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.clientId, clientId), eq(idempotencyKeys.key, key)))
  if (!row) return null
  if (row.requestHash !== hash) throw conflict('This Idempotency-Key was already used for a different request')
  return { status: row.responseStatus, body: row.responseBody }
}
