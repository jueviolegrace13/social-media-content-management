import { randomUUID } from 'node:crypto'
import { and, eq, isNull, lt, sql } from 'drizzle-orm'
import { getDb, rowsOf } from '../db/client.js'
import { mediaAssets } from '../db/schema.js'
import type { TenantScope } from '../db/tenantScope.js'
import { cleanImage } from '../lib/images.js'
import { sha256Hex } from '../lib/signing.js'
import { getStorage } from '../lib/storage.js'
import { previousResult, requestHash, type StoredResult } from './idempotency.js'

/** Media uploads (FR-3): validated, re-encoded, stored under an unguessable key, reusable across a tenant's posts. */

export type MediaAsset = typeof mediaAssets.$inferSelect

export function mediaView(row: MediaAsset) {
  return {
    id: row.id,
    url: row.publicUrl,
    content_type: row.contentType,
    width: row.width,
    height: row.height,
    size_bytes: row.sizeBytes,
    created_at: row.createdAt,
  }
}

export const UNUSED_MEDIA_DAYS = 7

export async function uploadMedia(scope: TenantScope, clientId: string, key: string, bytes: Uint8Array): Promise<StoredResult> {
  const hash = requestHash('POST /v1/media', scope.tenantId, bytes)
  const previous = await previousResult(clientId, key, hash)
  if (previous) return previous

  const sha = sha256Hex(bytes)
  const [same] = await scope.select(mediaAssets, eq(mediaAssets.sha256, sha))
  if (same) return (await saveKeyOnly(clientId, key, hash, 200, mediaView(same))) ?? (await previousResult(clientId, key, hash))!

  const image = await cleanImage(bytes)
  const id = randomUUID()
  const storageKey = `t/${scope.tenantId}/${randomUUID()}.${image.extension}`
  const storage = getStorage()
  const publicUrl = await storage.put(storageKey, image.bytes, image.contentType)
  const body = {
    id,
    url: publicUrl,
    content_type: image.contentType,
    width: image.width,
    height: image.height,
    size_bytes: image.bytes.length,
    created_at: new Date().toISOString(),
  }

  // The key and the asset are written by one statement: both or neither.
  const result = await getDb().execute(sql`
    WITH k AS (
      INSERT INTO idempotency_keys (client_id, key, request_hash, response_status, response_body)
      VALUES (${clientId}::uuid, ${key}, ${hash}, 201, ${JSON.stringify(body)}::jsonb)
      ON CONFLICT DO NOTHING RETURNING 1
    )
    INSERT INTO media_assets (id, tenant_id, storage_key, public_url, content_type, width, height, size_bytes, sha256, created_by_client_id)
    SELECT ${id}::uuid, ${scope.tenantId}::uuid, ${storageKey}, ${publicUrl}, ${image.contentType}, ${image.width}, ${image.height},
           ${image.bytes.length}, ${sha}, ${clientId}::uuid
    FROM k
    RETURNING id`)
  if (rowsOf(result).length === 0) {
    // Another request with the same key won the race; drop our copy and answer like it did.
    await storage.delete(storageKey).catch(() => undefined)
    return (await previousResult(clientId, key, hash))!
  }
  return { status: 201, body }
}

async function saveKeyOnly(clientId: string, key: string, hash: string, status: number, body: unknown): Promise<StoredResult | null> {
  const result = await getDb().execute(sql`
    INSERT INTO idempotency_keys (client_id, key, request_hash, response_status, response_body)
    VALUES (${clientId}::uuid, ${key}, ${hash}, ${status}, ${JSON.stringify(body)}::jsonb)
    ON CONFLICT DO NOTHING RETURNING 1`)
  return rowsOf(result).length > 0 ? { status, body } : null
}

/**
 * Daily: deletes uploads no post used within 7 days (FR-3.4). The row goes first (only if still unused), then the
 * object, so a post can never point at a deleted file; a failed object delete just leaves an unreferenced file.
 */
export async function deleteUnusedMedia(at: Date = new Date()): Promise<number> {
  const cutoff = new Date(at.getTime() - UNUSED_MEDIA_DAYS * 86_400_000)
  const rows = await getDb()
    .delete(mediaAssets)
    .where(and(isNull(mediaAssets.attachedAt), lt(mediaAssets.createdAt, cutoff)))
    .returning({ id: mediaAssets.id, storageKey: mediaAssets.storageKey })
  for (const row of rows) {
    await getStorage()
      .delete(row.storageKey)
      .catch((error) => console.error('Could not delete unused media object', row.id, error))
  }
  return rows.length
}
