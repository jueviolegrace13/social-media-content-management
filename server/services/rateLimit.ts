import type { Context } from 'hono'
import { sql } from 'drizzle-orm'
import { getDb, rowsOf } from '../db/client.js'
import { tooManyRequests } from '../errors.js'

/**
 * Fixed-window counters kept in Postgres, so every serverless instance shares them (same approach as Open Play).
 * Each call is one atomic upsert; the Neon HTTP driver has no transactions.
 */
export type RuleName = 'client' | 'adminSignInIp' | 'adminSignInEmail'

export const LIMITS: Record<RuleName, { limit: number; windowSec: number }> = {
  /** Signed API requests per client. */
  client: { limit: 300, windowSec: 60 },
  adminSignInIp: { limit: 20, windowSec: 900 },
  /** Failed sign-ins only. */
  adminSignInEmail: { limit: 5, windowSec: 900 },
}

const keyOf = (rule: RuleName, key: string) => `${rule}:${key}`

/** Counts one more hit in the rule's current window (restarting an expired one); returns the new count. */
export async function bump(rule: RuleName, key: string, now: Date = new Date()): Promise<number> {
  const { windowSec } = LIMITS[rule]
  const at = now.toISOString()
  const result = await getDb().execute(sql`
    INSERT INTO rate_limits (key, window_start, count) VALUES (${keyOf(rule, key)}, ${at}::timestamptz, 1)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rate_limits.window_start <= ${at}::timestamptz - make_interval(secs => ${windowSec})
                   THEN 1 ELSE rate_limits.count + 1 END,
      window_start = CASE WHEN rate_limits.window_start <= ${at}::timestamptz - make_interval(secs => ${windowSec})
                   THEN ${at}::timestamptz ELSE rate_limits.window_start END
    RETURNING count`)
  return Number(rowsOf<{ count: number }>(result)[0]?.count ?? 0)
}

/** The current window's count, 0 when there is none or it has expired. Read only. */
export async function count(rule: RuleName, key: string, now: Date = new Date()): Promise<number> {
  const { windowSec } = LIMITS[rule]
  const result = await getDb().execute(sql`
    SELECT count FROM rate_limits
    WHERE key = ${keyOf(rule, key)} AND window_start > ${now.toISOString()}::timestamptz - make_interval(secs => ${windowSec})`)
  return Number(rowsOf<{ count: number }>(result)[0]?.count ?? 0)
}

/** Counts the hit and refuses it (429) once the window's limit is passed. */
export async function consume(rule: RuleName, key: string, now: Date = new Date()): Promise<void> {
  if ((await bump(rule, key, now)) > LIMITS[rule].limit) throw tooManyRequests()
}

/** Test hook: replaces some limits; returns a function that puts them back. */
export function overrideLimits(next: Partial<typeof LIMITS>): () => void {
  const saved = { ...LIMITS }
  Object.assign(LIMITS, next)
  return () => Object.assign(LIMITS, saved)
}

/** The caller's IP as Vercel reports it, or null when unknown. */
export function clientIp(c: Context): string | null {
  const real = c.req.header('x-real-ip')?.trim()
  return real || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || null
}

/** Drops counters whose window ended over a day ago. Returns how many. */
export async function purgeExpiredRateLimits(now: Date = new Date()): Promise<number> {
  const result = await getDb().execute(sql`
    DELETE FROM rate_limits WHERE window_start < ${now.toISOString()}::timestamptz - interval '1 day' RETURNING key`)
  return rowsOf<{ key: string }>(result).length
}
