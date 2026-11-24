import { timingSafeEqual } from 'node:crypto'
import { lt } from 'drizzle-orm'
import { Hono, type Context } from 'hono'
import { getDb } from '../db/client.js'
import { idempotencyKeys, requestNonces } from '../db/schema.js'
import { unauthorized } from '../errors.js'
import { NONCE_TTL_SECONDS } from '../lib/signing.js'
import { purgeExpiredAdminSessions } from '../services/admins.js'
import { purgeExpiredRateLimits } from '../services/rateLimit.js'

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

export async function cleanup(now: Date = new Date()) {
  const db = getDb()
  const nonces = await db
    .delete(requestNonces)
    .where(lt(requestNonces.createdAt, new Date(now.getTime() - NONCE_TTL_SECONDS * 1000)))
    .returning({ n: requestNonces.nonce })
  const keys = await db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.createdAt, new Date(now.getTime() - IDEMPOTENCY_DAYS * 86_400_000)))
    .returning({ k: idempotencyKeys.key })
  return {
    nonces: nonces.length,
    idempotencyKeys: keys.length,
    adminSessions: await purgeExpiredAdminSessions(now),
    rateLimits: await purgeExpiredRateLimits(now),
  }
}

export const cronRoute = new Hono().get('/cleanup', async (c) => {
  assertCron(c)
  return c.json(await cleanup())
})
