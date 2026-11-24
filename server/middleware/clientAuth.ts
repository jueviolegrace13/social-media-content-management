import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { getDb } from '../db/client.js'
import { requestNonces, tenants } from '../db/schema.js'
import { forTenant, type TenantScope } from '../db/tenantScope.js'
import { forbidden, unauthorized } from '../errors.js'
import { MAX_SKEW_SECONDS, NONCE_PATTERN, sign, signaturesMatch } from '../lib/signing.js'
import { activeClientWithSecret, touchLastUsed, type ApiClientView } from '../services/apiClients.js'
import { consume } from '../services/rateLimit.js'

export type ClientEnv = { Variables: { client: ApiClientView } }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One message for every signature failure, so callers can't probe which part was wrong. */
const invalid = () => unauthorized('Request signature is invalid')

/**
 * Verifies a signed client request (ADR-0007): known active client, timestamp within 5 minutes, valid HMAC, and a
 * nonce not seen before. The nonce is stored only after the signature checks out, so unsigned traffic can't fill
 * the table. Then counts the request against the client's rate limit.
 */
export const requireClient = createMiddleware<ClientEnv>(async (c, next) => {
  const clientId = c.req.header('x-client-id') ?? ''
  const timestamp = c.req.header('x-timestamp') ?? ''
  const nonce = c.req.header('x-nonce') ?? ''
  const signature = c.req.header('x-signature') ?? ''
  if (!UUID.test(clientId) || !/^\d{1,12}$/.test(timestamp) || !NONCE_PATTERN.test(nonce) || !/^[0-9a-f]{64}$/i.test(signature)) {
    throw invalid()
  }
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) {
    throw unauthorized('Request timestamp is outside the allowed window')
  }

  const found = await activeClientWithSecret(clientId)
  if (!found) throw invalid()

  const url = new URL(c.req.url)
  const body = new Uint8Array(await c.req.arrayBuffer())
  const expected = sign(found.secret, c.req.method, url.pathname + url.search, timestamp, nonce, body)
  if (!signaturesMatch(expected, signature)) throw invalid()

  const stored = await getDb()
    .insert(requestNonces)
    .values({ clientId, nonce })
    .onConflictDoNothing()
    .returning({ nonce: requestNonces.nonce })
  if (stored.length === 0) throw unauthorized('Request was already used')

  await consume('client', clientId)
  await touchLastUsed(clientId)
  c.set('client', found.client)
  await next()
})

export function requireScope(c: Context<ClientEnv>, scope: string): void {
  if (!c.get('client').scopes.includes(scope)) throw forbidden('This client lacks the required scope')
}

/**
 * The tenant scope for a client acting on `tenantId`. Refused unless the client is linked to that tenant and the
 * tenant is active. Same answer for "not yours" and "doesn't exist", so tenant IDs can't be probed.
 */
export async function clientTenant(c: Context<ClientEnv>, tenantId: string): Promise<TenantScope> {
  const client = c.get('client')
  if (!UUID.test(tenantId) || !client.tenantIds.includes(tenantId)) throw forbidden('This client may not act for that tenant')
  const [tenant] = await getDb()
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.id, tenantId), eq(tenants.status, 'active')))
  if (!tenant) throw forbidden('This client may not act for that tenant')
  return forTenant(getDb(), tenantId)
}
