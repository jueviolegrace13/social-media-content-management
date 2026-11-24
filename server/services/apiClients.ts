import { randomBytes, randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { apiClients, apiClientTenants, tenants } from '../db/schema.js'
import { badRequest, conflict, notFound } from '../errors.js'
import { aadFor, decrypt, encrypt, type Encrypted } from '../lib/encryption.js'

/**
 * Client apps (Open Play first) that call the API with signed requests (ADR-0007). The secret is stored
 * encrypted, because verifying an HMAC needs it, and is shown once when created or rotated.
 */

export const secretAad = (clientId: string) => aadFor(null, 'api_clients.secret', clientId)

function newSecret(): string {
  return randomBytes(32).toString('base64url')
}

function encryptedColumns(value: Encrypted) {
  return {
    secretKeyVersion: value.keyVersion,
    secretIv: value.iv,
    secretCiphertext: value.ciphertext,
    secretTag: value.tag,
  }
}

export function storedSecret(row: typeof apiClients.$inferSelect): Encrypted {
  return { keyVersion: row.secretKeyVersion, iv: row.secretIv, ciphertext: row.secretCiphertext, tag: row.secretTag }
}

export interface ApiClientView {
  id: string
  name: string
  scopes: string[]
  status: 'active' | 'revoked'
  webhookUrl: string | null
  tenantIds: string[]
  createdAt: Date
  rotatedAt: Date | null
  revokedAt: Date | null
  lastUsedAt: Date | null
}

async function assertTenantsExist(tenantIds: string[]): Promise<void> {
  if (tenantIds.length === 0) return
  const found = await getDb().select({ id: tenants.id }).from(tenants).where(inArray(tenants.id, tenantIds))
  if (found.length !== new Set(tenantIds).size) throw badRequest('Unknown tenant')
}

export async function createApiClient(input: {
  name: string
  scopes: string[]
  tenantIds: string[]
  webhookUrl?: string | null
}): Promise<{ client: ApiClientView; secret: string }> {
  const db = getDb()
  await assertTenantsExist(input.tenantIds)
  const [existing] = await db.select({ id: apiClients.id }).from(apiClients).where(eq(apiClients.name, input.name))
  if (existing) throw conflict('A client with that name already exists')
  const id = randomUUID()
  const secret = newSecret()
  await db.insert(apiClients).values({
    id,
    name: input.name,
    scopes: input.scopes,
    webhookUrl: input.webhookUrl ?? null,
    ...encryptedColumns(encrypt(secret, secretAad(id))),
  })
  if (input.tenantIds.length > 0) {
    await db.insert(apiClientTenants).values([...new Set(input.tenantIds)].map((tenantId) => ({ clientId: id, tenantId })))
  }
  return { client: (await getApiClient(id))!, secret }
}

export async function rotateApiClientSecret(id: string): Promise<{ client: ApiClientView; secret: string }> {
  const secret = newSecret()
  const updated = await getDb()
    .update(apiClients)
    .set({ ...encryptedColumns(encrypt(secret, secretAad(id))), rotatedAt: new Date() })
    .where(and(eq(apiClients.id, id), eq(apiClients.status, 'active')))
    .returning({ id: apiClients.id })
  if (updated.length === 0) throw notFound('Active API client')
  return { client: (await getApiClient(id))!, secret }
}

export async function revokeApiClient(id: string): Promise<ApiClientView> {
  const updated = await getDb()
    .update(apiClients)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(and(eq(apiClients.id, id), eq(apiClients.status, 'active')))
    .returning({ id: apiClients.id })
  if (updated.length === 0) throw notFound('Active API client')
  return (await getApiClient(id))!
}

export async function listApiClients(): Promise<ApiClientView[]> {
  const db = getDb()
  const rows = await db.select().from(apiClients).orderBy(asc(apiClients.name))
  const links = await db.select().from(apiClientTenants)
  return rows.map((row) => toView(row, links.filter((l) => l.clientId === row.id).map((l) => l.tenantId)))
}

export async function getApiClient(id: string): Promise<ApiClientView | null> {
  const db = getDb()
  const [row] = await db.select().from(apiClients).where(eq(apiClients.id, id))
  if (!row) return null
  const links = await db.select().from(apiClientTenants).where(eq(apiClientTenants.clientId, id))
  return toView(row, links.map((l) => l.tenantId))
}

/** The active client and its decrypted secret, for verifying a request. Null when unknown or revoked. */
export async function activeClientWithSecret(id: string): Promise<{ client: ApiClientView; secret: string } | null> {
  const [row] = await getDb()
    .select()
    .from(apiClients)
    .where(and(eq(apiClients.id, id), eq(apiClients.status, 'active')))
  if (!row) return null
  const links = await getDb().select().from(apiClientTenants).where(eq(apiClientTenants.clientId, id))
  return { client: toView(row, links.map((l) => l.tenantId)), secret: decrypt(storedSecret(row), secretAad(row.id)) }
}

/** Records use at most once a minute, so busy clients don't write on every request. */
export async function touchLastUsed(id: string, now: Date = new Date()): Promise<void> {
  await getDb()
    .update(apiClients)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(apiClients.id, id),
        sql`(${apiClients.lastUsedAt} IS NULL OR ${apiClients.lastUsedAt} < ${now.toISOString()}::timestamptz - interval '1 minute')`,
      ),
    )
}

function toView(row: typeof apiClients.$inferSelect, tenantIds: string[]): ApiClientView {
  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes,
    status: row.status,
    webhookUrl: row.webhookUrl,
    tenantIds,
    createdAt: row.createdAt,
    rotatedAt: row.rotatedAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
  }
}
