import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm'
import { getDb, rowsOf } from '../db/client.js'
import { mediaAssets, postMedia, posts, postTargets, publishAttempts, publishJobs, socialAccounts } from '../db/schema.js'
import { forTenant, type TenantScope } from '../db/tenantScope.js'
import { now, sleep } from '../lib/clock.js'
import { adapters, type NetworkAdapter } from '../networks/index.js'
import { MetaError, type ErrorKind } from '../networks/metaClient.js'
import { dedupeMarker, onPostNow, refreshPostStatus } from './posts.js'
import { accountToken, markReconnectNeeded } from './socialAccounts.js'

/**
 * The publishing engine (ADR-0005, ADR-0010).
 *
 * - Jobs are claimed with one atomic UPDATE ... FOR UPDATE SKIP LOCKED, so overlapping runs never take the same job
 *   and a destination is never published twice by two runners.
 * - A claimed job holds a 5-minute lease. A run that dies leaves the job `running`; the next run puts it back to
 *   `due` with "check before publish" set, because its call may have reached Meta.
 * - Transient errors retry after 1 minute, then 5 minutes, then in the next daily run; 5 attempts at most.
 *   Permanent errors fail at once with a readable reason. An unknown outcome retries, but first looks for the post
 *   on the Page (caption marker within the attempt window) and records it as published if it's there.
 */

const LEASE_MS = 5 * 60_000
export const MAX_ATTEMPTS = 5
/** After the first two retries, a job waits for the next daily run; any time before it works. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 60 * 60_000]
/** "Post now" keeps working this long after the response, so the 1-minute retry happens without the cron. */
export const POST_NOW_BUDGET_MS = 100_000

type Job = typeof publishJobs.$inferSelect

export function retryDelay(attempts: number): number {
  return RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]!
}

/** Claims up to `limit` due jobs (optionally only one post's), in one statement. */
export async function claimJobs(limit: number, postId?: string): Promise<Job[]> {
  const at = now()
  const onlyPost = postId
    ? sql`AND j.post_target_id IN (SELECT id FROM post_targets WHERE post_id = ${postId}::uuid)`
    : sql``
  const result = await getDb().execute(sql`
    UPDATE publish_jobs SET status = 'running', attempts = attempts + 1,
      locked_until = ${new Date(at.getTime() + LEASE_MS).toISOString()}::timestamptz, updated_at = ${at.toISOString()}::timestamptz
    WHERE id IN (
      SELECT j.id FROM publish_jobs j
      WHERE j.status = 'due' AND j.run_at <= ${at.toISOString()}::timestamptz ${onlyPost}
      ORDER BY j.run_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, tenant_id, post_target_id, status, run_at, attempts, locked_until, check_before_publish, created_at, updated_at`)
  return rowsOf<Record<string, unknown>>(result).map((r) => ({
    id: r.id as string,
    tenantId: r.tenant_id as string,
    postTargetId: r.post_target_id as string,
    status: r.status as Job['status'],
    runAt: new Date(r.run_at as string),
    attempts: Number(r.attempts),
    lockedUntil: r.locked_until ? new Date(r.locked_until as string) : null,
    checkBeforePublish: r.check_before_publish === true || r.check_before_publish === 't',
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  }))
}

/** Jobs whose run died (lease expired) go back to the queue, marked to check the Page before publishing again. */
export async function releaseStuckJobs(): Promise<number> {
  const at = now()
  const released = await getDb()
    .update(publishJobs)
    .set({ status: 'due', lockedUntil: null, checkBeforePublish: true, runAt: at, updatedAt: at })
    .where(and(eq(publishJobs.status, 'running'), sql`${publishJobs.lockedUntil} < ${at.toISOString()}::timestamptz`))
    .returning({ id: publishJobs.id })
  return released.length
}

interface Failure {
  kind: ErrorKind
  message: string
  httpStatus: number | null
  code: number | null
  subcode: number | null
  reconnect: boolean
}

function failureOf(error: unknown): Failure {
  if (error instanceof MetaError) {
    return { kind: error.kind, message: error.message, httpStatus: error.httpStatus, code: error.code, subcode: error.subcode, reconnect: error.needsReconnect }
  }
  // Our own failure mid-publish (database, decryption): we can't be sure the post didn't go out.
  console.error('Publish failed unexpectedly', error)
  return { kind: 'unknown', message: 'Unexpected error while publishing', httpStatus: null, code: null, subcode: null, reconnect: false }
}

const permanent = (message: string): Failure => ({ kind: 'permanent', message, httpStatus: null, code: null, subcode: null, reconnect: false })

/** Processes one claimed job: one attempt row, one network call (plus a lookup when checking first). */
export async function processJob(job: Job): Promise<'published' | 'retry' | 'failed' | 'skipped'> {
  const scope = forTenant(getDb(), job.tenantId)
  const startedAt = now()
  // Moves the target to publishing, unless it was cancelled meanwhile.
  const [target] = await scope.update(
    postTargets,
    { status: 'publishing', updatedAt: startedAt },
    and(eq(postTargets.id, job.postTargetId), inArray(postTargets.status, ['pending', 'publishing'])),
  )
  if (!target) {
    await scope.update(publishJobs, { status: 'done', lockedUntil: null, updatedAt: startedAt }, eq(publishJobs.id, job.id))
    return 'skipped'
  }
  await refreshPostStatus(scope, target.postId)

  const [attempt] = await scope.insert(publishAttempts, { postTargetId: target.id, startedAt })
  const [post] = await scope.select(posts, eq(posts.id, target.postId))
  const [account] = await scope.select(socialAccounts, eq(socialAccounts.id, target.socialAccountId))

  let result: { externalPostId: string; permalink: string | null } | null = null
  let failure: Failure | null = null
  try {
    const token = account && account.status === 'connected' ? accountToken(account) : null
    if (!post || !account) failure = permanent('The post or its account no longer exists')
    else if (!token) failure = permanent(`${account.name} needs to be reconnected (${account.status.replace('_', ' ')})`)
    else {
      const adapter = adapters[account.network]
      if (job.checkBeforePublish) result = await findExisting(scope, adapter, target, attempt!.id, account.externalId, token)
      if (!result) {
        const links = await scope.select(postMedia, eq(postMedia.postId, post.id), { orderBy: [asc(postMedia.position)] })
        const assets = links.length ? await scope.select(mediaAssets, inArray(mediaAssets.id, links.map((l) => l.mediaAssetId))) : []
        const imageUrls = links.map((l) => assets.find((a) => a.id === l.mediaAssetId)!.publicUrl)
        result = await adapter.publish({ token, accountExternalId: account.externalId, caption: post.caption, imageUrls })
      }
    }
  } catch (error) {
    failure = failureOf(error)
  }

  const finishedAt = now()
  if (result) {
    await scope.update(
      publishAttempts,
      { finishedAt, outcome: 'success', externalPostId: result.externalPostId },
      eq(publishAttempts.id, attempt!.id),
    )
    await scope.update(
      postTargets,
      { status: 'published', externalPostId: result.externalPostId, permalink: result.permalink, publishedAt: finishedAt, errorCode: null, errorMessage: null, updatedAt: finishedAt },
      eq(postTargets.id, target.id),
    )
    await scope.update(publishJobs, { status: 'done', lockedUntil: null, updatedAt: finishedAt }, eq(publishJobs.id, job.id))
    await refreshPostStatus(scope, target.postId)
    return 'published'
  }

  const f = failure!
  await scope.update(
    publishAttempts,
    {
      finishedAt,
      outcome: f.kind === 'permanent' ? 'permanent_error' : f.kind === 'transient' ? 'transient_error' : 'unknown',
      httpStatus: f.httpStatus,
      metaErrorCode: f.code,
      metaErrorSubcode: f.subcode,
      message: f.message,
    },
    eq(publishAttempts.id, attempt!.id),
  )
  if (f.reconnect && account) await markReconnectNeeded(scope, account.id, f.message)

  const giveUp = f.kind === 'permanent' || job.attempts >= MAX_ATTEMPTS
  if (giveUp) {
    const errorCode = f.code !== null ? `meta_${f.code}${f.subcode !== null ? `_${f.subcode}` : ''}` : f.kind === 'permanent' ? 'permanent' : 'too_many_attempts'
    const errorMessage = f.kind === 'permanent' ? f.message : `Gave up after ${job.attempts} attempts. Last error: ${f.message}`
    await scope.update(postTargets, { status: 'failed', errorCode, errorMessage, updatedAt: finishedAt }, eq(postTargets.id, target.id))
    await scope.update(publishJobs, { status: 'dead', lockedUntil: null, updatedAt: finishedAt }, eq(publishJobs.id, job.id))
    await refreshPostStatus(scope, target.postId)
    return 'failed'
  }

  await scope.update(postTargets, { status: 'pending', updatedAt: finishedAt }, eq(postTargets.id, target.id))
  await scope.update(
    publishJobs,
    {
      status: 'due',
      lockedUntil: null,
      runAt: new Date(finishedAt.getTime() + retryDelay(job.attempts)),
      // Once an outcome was unknown, every later try checks the Page first.
      checkBeforePublish: job.checkBeforePublish || f.kind === 'unknown',
      updatedAt: finishedAt,
    },
    eq(publishJobs.id, job.id),
  )
  await refreshPostStatus(scope, target.postId)
  return 'retry'
}

/**
 * Looks for this target's post on the Page, created since its first earlier attempt (minus clock slack). With no
 * earlier attempt nothing can have been sent, so there's nothing to look for.
 */
async function findExisting(
  scope: TenantScope,
  adapter: NetworkAdapter,
  target: typeof postTargets.$inferSelect,
  currentAttemptId: string,
  pageId: string,
  token: string,
): Promise<{ externalPostId: string; permalink: string | null } | null> {
  const [first] = await scope.select(publishAttempts, and(eq(publishAttempts.postTargetId, target.id), ne(publishAttempts.id, currentAttemptId)), {
    orderBy: [asc(publishAttempts.startedAt)],
    limit: 1,
  })
  if (!first) return null
  const since = new Date(first.startedAt.getTime() - 2 * 60_000)
  const recent = await adapter.recentPosts({ token, accountExternalId: pageId, since })
  const match = recent.find((p) => p.createdAt >= since && dedupeMarker(p.message) === target.dedupeMarker)
  return match ? { externalPostId: match.externalPostId, permalink: match.permalink } : null
}

/**
 * Claims and processes due jobs until none are left or the deadline passes. With `postId`, only that post's jobs;
 * with `waitForRetries`, it also waits for a retry that falls before the deadline ("post now").
 */
export async function runJobs(opts: { deadline: number; postId?: string; waitForRetries?: boolean }): Promise<{ processed: number; published: number }> {
  let processed = 0
  let published = 0
  while (now().getTime() < opts.deadline) {
    const jobs = await claimJobs(5, opts.postId)
    if (jobs.length === 0) {
      if (!opts.waitForRetries || !opts.postId) break
      const next = await nextRunAt(opts.postId)
      if (!next || next.getTime() >= opts.deadline) break
      await sleep(next.getTime() - now().getTime())
      continue
    }
    for (const job of jobs) {
      processed++
      if ((await processJob(job)) === 'published') published++
    }
  }
  return { processed, published }
}

async function nextRunAt(postId: string): Promise<Date | null> {
  const result = await getDb().execute(sql`
    SELECT min(j.run_at) AS next FROM publish_jobs j JOIN post_targets t ON t.id = j.post_target_id
    WHERE t.post_id = ${postId}::uuid AND j.status = 'due'`)
  const next = rowsOf<{ next: string | null }>(result)[0]?.next
  return next ? new Date(next) : null
}

export async function countDueJobs(): Promise<number> {
  const result = await getDb().execute(sql`SELECT count(*)::int AS n FROM publish_jobs WHERE status = 'due' AND run_at <= ${now().toISOString()}::timestamptz`)
  return Number(rowsOf<{ n: number }>(result)[0]?.n ?? 0)
}

/** "Post now": publish one post right after the response, retrying once within the budget. */
export function publishPostNow(_tenantId: string, postId: string) {
  return runJobs({ postId, deadline: now().getTime() + POST_NOW_BUDGET_MS, waitForRetries: true })
}

onPostNow(publishPostNow)
