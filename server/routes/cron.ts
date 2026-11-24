import { timingSafeEqual } from 'node:crypto'
import { and, inArray, lt } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { getDb } from '../db/client.js'
import { idempotencyKeys, oauthStates, posts, publishAttempts, requestNonces, webhookDeliveries } from '../db/schema.js'
import { unauthorized } from '../errors.js'
import { now } from '../lib/clock.js'
import { NONCE_TTL_SECONDS } from '../lib/signing.js'
import { purgeExpiredAdminSessions } from '../services/admins.js'
import { deleteUnusedMedia } from '../services/media.js'
import { countDueJobs, releaseStuckJobs, runJobs } from '../services/publisher.js'
import { purgeExpiredRateLimits } from '../services/rateLimit.js'
import { checkAllAccounts } from '../services/socialAccounts.js'
import { drainWebhooks } from '../services/webhooks.js'

/**
 * Scheduled jobs (vercel.json "crons"). Vercel calls them with `Authorization: Bearer $CRON_SECRET`; without
 * that secret configured every call is refused.
 */
function assertCron(c: Context): void {
  const secret = process.env.CRON_SECRET ?? ''
  const given = Buffer.from(c.req.header('authorization') ?? '')
  const expected = Buffer.from(`Bearer ${secret}`)
  if (!secret || given.length !== expected.length || !timingSafeEqual(given, expected)) throw unauthorized('Not allowed')
}

const IDEMPOTENCY_DAYS = 7
const ATTEMPT_DAYS = 90
const WEBHOOK_DAYS = 30
const POST_DAYS = 2 * 365
const days = (at: Date, n: number) => new Date(at.getTime() - n * 86_400_000)

/** Daily housekeeping, plus the account health check (FR-2.2) and unused media removal (FR-3.4). */
export async function cleanup(at: Date = new Date()) {
  const db = getDb()
  const nonces = await db
    .delete(requestNonces)
    .where(lt(requestNonces.createdAt, new Date(at.getTime() - NONCE_TTL_SECONDS * 1000)))
    .returning({ n: requestNonces.nonce })
  const keys = await db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.createdAt, days(at, IDEMPOTENCY_DAYS)))
    .returning({ k: idempotencyKeys.key })
  const attempts = await db.delete(publishAttempts).where(lt(publishAttempts.startedAt, days(at, ATTEMPT_DAYS))).returning({ id: publishAttempts.id })
  const webhooks = await db
    .delete(webhookDeliveries)
    .where(and(inArray(webhookDeliveries.status, ['delivered', 'failed']), lt(webhookDeliveries.createdAt, days(at, WEBHOOK_DAYS))))
    .returning({ id: webhookDeliveries.id })
  const oldPosts = await db.delete(posts).where(lt(posts.createdAt, days(at, POST_DAYS))).returning({ id: posts.id })
  await db.delete(oauthStates).where(lt(oauthStates.expiresAt, at))
  return {
    nonces: nonces.length,
    idempotencyKeys: keys.length,
    adminSessions: await purgeExpiredAdminSessions(at),
    rateLimits: await purgeExpiredRateLimits(at),
    publishAttempts: attempts.length,
    webhookDeliveries: webhooks.length,
    posts: oldPosts.length,
    unusedMedia: await deleteUnusedMedia(at),
    accounts: await checkAllAccounts(),
  }
}

/** The run keeps a margin under the function's 300-second limit. */
export const RUN_BUDGET_MS = 240_000

/** The daily publishing run (ADR-0005): stuck jobs back to the queue, due jobs published, webhooks sent. */
export async function runScheduled(budgetMs = RUN_BUDGET_MS) {
  const started = Date.now()
  const released = await releaseStuckJobs()
  // Jobs get most of the budget; webhooks the rest.
  const jobs = await runJobs({ deadline: now().getTime() + budgetMs * 0.8 })
  const webhooks = await drainWebhooks(started + budgetMs)
  const remaining = await countDueJobs()
  if (remaining > 0) console.warn(`Publishing run stopped with ${remaining} due jobs left; they wait for the next run`)
  return { released, ...jobs, remaining, webhooks }
}

export const cronRoute = new Hono()
  .get('/cleanup', async (c) => {
    assertCron(c)
    return c.json(await cleanup())
  })
  .get('/run-jobs', async (c) => {
    assertCron(c)
    return c.json(await runScheduled())
  })
