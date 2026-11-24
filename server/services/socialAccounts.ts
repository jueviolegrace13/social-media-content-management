import { randomUUID } from 'node:crypto'
import { and, asc, eq, sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { socialAccounts } from '../db/schema.js'
import { forTenant, type TenantScope } from '../db/tenantScope.js'
import { notFound } from '../errors.js'
import { aadFor, decrypt, encrypt, type Encrypted } from '../lib/encryption.js'
import { adapters } from '../networks/index.js'
import { MetaError } from '../networks/metaClient.js'

/**
 * Connected destinations (FR-2). The token is encrypted with AAD bound to the tenant and row, decrypted only for a
 * call, and removed on disconnect.
 */

export type SocialAccount = typeof socialAccounts.$inferSelect

export const tokenAad = (tenantId: string, accountId: string) => aadFor(tenantId, 'social_accounts.token', accountId)

export function storedToken(row: SocialAccount): Encrypted | null {
  if (row.tokenKeyVersion === null || !row.tokenIv || !row.tokenCiphertext || !row.tokenTag) return null
  return { keyVersion: row.tokenKeyVersion, iv: row.tokenIv, ciphertext: row.tokenCiphertext, tag: row.tokenTag }
}

export const tokenColumns = (value: Encrypted) => ({
  tokenKeyVersion: value.keyVersion,
  tokenIv: value.iv,
  tokenCiphertext: value.ciphertext,
  tokenTag: value.tag,
})

/** The decrypted token, or null when the account has none (disconnected). Never log the result. */
export function accountToken(row: SocialAccount): string | null {
  const stored = storedToken(row)
  return stored ? decrypt(stored, tokenAad(row.tenantId, row.id)) : null
}

/** What clients and the admin UI see. Never includes the token. */
export function accountView(row: SocialAccount) {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    network: row.network,
    external_id: row.externalId,
    name: row.name,
    picture_url: row.pictureUrl,
    status: row.status,
    last_checked_at: row.lastCheckedAt,
    last_error: row.lastError,
  }
}

export async function listAccounts(scope: TenantScope): Promise<SocialAccount[]> {
  return (await scope.select(socialAccounts)).sort((a, b) => a.name.localeCompare(b.name))
}

export async function listAllAccounts(): Promise<SocialAccount[]> {
  return getDb().select().from(socialAccounts).orderBy(asc(socialAccounts.name))
}

export async function getAccount(scope: TenantScope, id: string): Promise<SocialAccount | null> {
  const [row] = await scope.select(socialAccounts, eq(socialAccounts.id, id))
  return row ?? null
}

/** Platform-wide lookup for admin routes; the caller then works through `forTenant(row.tenantId)`. */
export async function findAccount(id: string): Promise<SocialAccount | null> {
  const [row] = await getDb().select().from(socialAccounts).where(eq(socialAccounts.id, id))
  return row ?? null
}

/** Connects a Facebook Page, or refreshes the token of one already connected (reconnect). */
export async function upsertFacebookPage(
  tenantId: string,
  page: { pageId: string; name: string; pictureUrl: string | null; token: string },
  connectedBy: string,
): Promise<SocialAccount> {
  const scope = forTenant(getDb(), tenantId)
  const [existing] = await scope.select(
    socialAccounts,
    and(eq(socialAccounts.network, 'facebook_page'), eq(socialAccounts.externalId, page.pageId)),
  )
  const now = new Date()
  if (existing) {
    const [row] = await scope.update(
      socialAccounts,
      {
        ...tokenColumns(encrypt(page.token, tokenAad(tenantId, existing.id))),
        name: page.name,
        pictureUrl: page.pictureUrl,
        status: 'connected',
        lastError: null,
        lastCheckedAt: now,
        connectedBy,
        updatedAt: now,
      },
      eq(socialAccounts.id, existing.id),
    )
    return row!
  }
  const id = randomUUID()
  const [row] = await scope.insert(socialAccounts, {
    id,
    network: 'facebook_page',
    externalId: page.pageId,
    name: page.name,
    pictureUrl: page.pictureUrl,
    ...tokenColumns(encrypt(page.token, tokenAad(tenantId, id))),
    status: 'connected',
    lastCheckedAt: now,
    connectedBy,
  })
  return row!
}

/** Deletes the stored token (FR-2.3). Pending posts to this account fail when they run. */
export async function disconnectAccount(scope: TenantScope, id: string): Promise<SocialAccount> {
  const [row] = await scope.update(
    socialAccounts,
    { status: 'disconnected', tokenKeyVersion: null, tokenIv: null, tokenCiphertext: null, tokenTag: null, updatedAt: new Date() },
    eq(socialAccounts.id, id),
  )
  if (!row) throw notFound('Account')
  return row
}

export async function markReconnectNeeded(scope: TenantScope, id: string, reason: string): Promise<void> {
  await scope.update(
    socialAccounts,
    { status: 'reconnect_needed', lastError: reason, lastCheckedAt: new Date(), updatedAt: new Date() },
    and(eq(socialAccounts.id, id), sql`${socialAccounts.status} = 'connected'`),
  )
}

/**
 * Health check (FR-2.2): calls the network with the stored token. An invalid token marks the account
 * "reconnect needed"; a transient failure only records the error.
 */
export async function checkAccount(row: SocialAccount): Promise<SocialAccount> {
  const scope = forTenant(getDb(), row.tenantId)
  const token = accountToken(row)
  if (!token) return row
  const now = new Date()
  try {
    const info = await adapters[row.network].checkHealth({ token, accountExternalId: row.externalId })
    const [updated] = await scope.update(
      socialAccounts,
      { name: info.name, pictureUrl: info.pictureUrl, status: 'connected', lastError: null, lastCheckedAt: now, updatedAt: now },
      eq(socialAccounts.id, row.id),
    )
    return updated!
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Health check failed'
    const reconnect = error instanceof MetaError && (error.needsReconnect || (error.kind === 'permanent' && error.code === 100))
    const [updated] = await scope.update(
      socialAccounts,
      { ...(reconnect ? { status: 'reconnect_needed' as const } : {}), lastError: message, lastCheckedAt: now, updatedAt: now },
      eq(socialAccounts.id, row.id),
    )
    return updated!
  }
}

/** Daily: checks every account that still has a token. */
export async function checkAllAccounts(): Promise<{ checked: number; reconnectNeeded: number }> {
  const rows = await getDb().select().from(socialAccounts).where(sql`${socialAccounts.status} <> 'disconnected'`)
  let reconnectNeeded = 0
  for (const row of rows) if ((await checkAccount(row)).status === 'reconnect_needed') reconnectNeeded++
  return { checked: rows.length, reconnectNeeded }
}
