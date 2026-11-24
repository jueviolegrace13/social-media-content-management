import { randomBytes, randomUUID } from 'node:crypto'
import { and, asc, eq, lte, sql } from 'drizzle-orm'
import { getDb, rowsOf } from '../db/client.js'
import { apiClients, webhookDeliveries } from '../db/schema.js'
import { runInBackground } from '../lib/background.js'
import { now } from '../lib/clock.js'
import { sign } from '../lib/signing.js'
import { webhookSecretOf } from './apiClients.js'

/**
 * Signed status webhooks to client apps (ADR-0007, docs/integration-open-play.md). At-least-once: each event is a
 * row, tried right away and then by the daily run with backoff, for up to 24 hours. Receivers deduplicate on
 * `event_id`.
 *
 * Request: `POST <webhook_url>` with JSON body and headers `X-Event-Id`, `X-Timestamp`, `X-Nonce`, `X-Signature`.
 * The signature is the request-signing scheme with the client's webhook secret, over the webhook URL's path:
 * hex(HMAC-SHA256(secret, "POST\n" + PATH + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + hex(SHA-256(body)))).
 */

export const WEBHOOK_TYPES = ['post.published', 'post.partially_published', 'post.failed', 'post.cancelled', 'post.taken_down'] as const
export type WebhookType = (typeof WEBHOOK_TYPES)[number]

const BACKOFF_MINUTES = [1, 5, 30, 120, 360]
const GIVE_UP_MS = 24 * 3600_000
const TIMEOUT_MS = 10_000
/** While one sender holds a delivery, others leave it alone. */
const LEASE_MS = 60_000

type FetchFn = (url: string, init: RequestInit) => Promise<Response>
let webhookFetch: FetchFn = (url, init) => fetch(url, init)

/** Test hook. */
export function setWebhookFetch(next: FetchFn | undefined): void {
  webhookFetch = next ?? ((url, init) => fetch(url, init))
}

/**
 * Queues an event for the client that created the post, if it has a webhook URL and secret, and tries to send it
 * right away (after the response). Returns the event ID, or null when there's no one to tell.
 */
export async function enqueueWebhook(input: {
  clientId: string | null
  tenantId: string
  type: WebhookType
  post: Record<string, unknown>
}): Promise<string | null> {
  if (!input.clientId) return null
  const [client] = await getDb().select().from(apiClients).where(eq(apiClients.id, input.clientId))
  if (!client || client.status !== 'active' || !client.webhookUrl || !webhookSecretOf(client)) return null
  const id = randomUUID()
  const at = now()
  const payload = { event_id: id, type: input.type, occurred_at: at.toISOString(), post: input.post }
  await getDb().insert(webhookDeliveries).values({ id, clientId: client.id, tenantId: input.tenantId, type: input.type, payload, nextAttemptAt: at, createdAt: at })
  runInBackground(`webhook ${id}`, () => deliverWebhook(id))
  return id
}

/** One delivery attempt. Claims the row first, so the immediate send and the daily run can't both send it. */
export async function deliverWebhook(id: string): Promise<'delivered' | 'retry' | 'failed' | 'skipped'> {
  const at = now()
  const claimed = await getDb()
    .update(webhookDeliveries)
    .set({ attempts: sql`${webhookDeliveries.attempts} + 1`, nextAttemptAt: new Date(at.getTime() + LEASE_MS) })
    .where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.status, 'pending'), lte(webhookDeliveries.nextAttemptAt, at)))
    .returning()
  const row = claimed[0]
  if (!row) return 'skipped'

  const [client] = await getDb().select().from(apiClients).where(eq(apiClients.id, row.clientId))
  const secret = client ? webhookSecretOf(client) : null
  let status: number | null = null
  let error: string | null = null
  if (!client || client.status !== 'active' || !client.webhookUrl || !secret) {
    error = 'Client has no active webhook'
  } else {
    const body = JSON.stringify(row.payload)
    const url = new URL(client.webhookUrl)
    const timestamp = String(Math.floor(Date.now() / 1000))
    const nonce = randomBytes(16).toString('hex')
    try {
      const res = await webhookFetch(client.webhookUrl, {
        method: 'POST',
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          'content-type': 'application/json',
          'x-event-id': row.id,
          'x-timestamp': timestamp,
          'x-nonce': nonce,
          'x-signature': sign(secret, 'POST', url.pathname + url.search, timestamp, nonce, body),
        },
      })
      status = res.status
      if (!res.ok) error = `HTTP ${res.status}`
    } catch (e) {
      error = e instanceof Error && e.name === 'TimeoutError' ? 'Timed out' : 'Could not connect'
    }
  }

  if (!error) {
    await getDb()
      .update(webhookDeliveries)
      .set({ status: 'delivered', deliveredAt: now(), lastResponseStatus: status, lastError: null })
      .where(eq(webhookDeliveries.id, id))
    return 'delivered'
  }
  const giveUp = at.getTime() - row.createdAt.getTime() >= GIVE_UP_MS
  const delay = BACKOFF_MINUTES[Math.min(row.attempts - 1, BACKOFF_MINUTES.length - 1)]! * 60_000
  await getDb()
    .update(webhookDeliveries)
    .set({
      status: giveUp ? 'failed' : 'pending',
      nextAttemptAt: new Date(at.getTime() + delay),
      lastResponseStatus: status,
      lastError: error,
    })
    .where(eq(webhookDeliveries.id, id))
  return giveUp ? 'failed' : 'retry'
}

/** Daily run: sends every delivery that's due, until the deadline. */
export async function drainWebhooks(deadline: number): Promise<{ delivered: number; pending: number }> {
  let delivered = 0
  const seen = new Set<string>()
  while (Date.now() < deadline) {
    const due = await getDb()
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.status, 'pending'), lte(webhookDeliveries.nextAttemptAt, now())))
      .orderBy(asc(webhookDeliveries.nextAttemptAt))
      .limit(20)
    const fresh = due.filter((d) => !seen.has(d.id))
    if (fresh.length === 0) break
    for (const { id } of fresh) {
      seen.add(id)
      if ((await deliverWebhook(id)) === 'delivered') delivered++
      if (Date.now() >= deadline) break
    }
  }
  const left = await getDb().execute(sql`SELECT count(*)::int AS n FROM webhook_deliveries WHERE status = 'pending'`)
  return { delivered, pending: Number(rowsOf<{ n: number }>(left)[0]?.n ?? 0) }
}
