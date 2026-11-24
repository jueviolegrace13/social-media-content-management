import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { getDb, rowsOf } from '../db/client.js'
import { mediaAssets, postMedia, posts, postTargets, publishAttempts, publishJobs, socialAccounts, POST_STATUSES } from '../db/schema.js'
import type { TenantScope } from '../db/tenantScope.js'
import { AppError, badRequest, conflict, notFound } from '../errors.js'
import { runInBackground } from '../lib/background.js'
import { now } from '../lib/clock.js'
import { sha256Hex } from '../lib/signing.js'
import { adapters } from '../networks/index.js'
import { MetaError } from '../networks/metaClient.js'
import { previousResult, requestHash, type StoredResult } from './idempotency.js'
import { accountToken, markReconnectNeeded } from './socialAccounts.js'
import { enqueueWebhook, type WebhookType } from './webhooks.js'

/**
 * Posts and their destinations (FR-4, FR-6). A post is network-agnostic; each destination is a `post_targets` row
 * with its own status and a `publish_jobs` row in the queue. The post's status is rolled up from its targets.
 */

export type Post = typeof posts.$inferSelect
export type PostTarget = typeof postTargets.$inferSelect
export type PostStatus = (typeof POST_STATUSES)[number]

export const createPostBody = z.object({
  tenant_id: z.uuid().optional(),
  caption: z.string().max(63_206).default(''),
  media_ids: z.array(z.uuid()).max(10).default([]),
  account_ids: z.array(z.uuid()).min(1).max(20),
  scheduled_for: z.iso.datetime({ offset: true }).nullish(),
  source: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9_.:-]{0,99}$/, 'Use lowercase letters, digits and . _ : -'),
  source_ref: z.string().trim().min(1).max(200).nullish(),
})
export type CreatePostInput = z.infer<typeof createPostBody>

/** Normalized caption hash, matched against the Page's recent posts after an unknown outcome (ADR-0010). */
export function dedupeMarker(caption: string): string {
  return sha256Hex(caption.replace(/\r\n/g, '\n').trim()).slice(0, 32)
}

// ---------------------------------------------------------------------------------------------------------------
// Status roll-up (docs/domain-model.md, status rules)

const FINAL_WEBHOOK: Partial<Record<PostStatus, WebhookType>> = {
  published: 'post.published',
  partially_published: 'post.partially_published',
  failed: 'post.failed',
  cancelled: 'post.cancelled',
}

export function rollUpStatus(targetStatuses: PostTarget['status'][], scheduledFor: Date | null): PostStatus {
  const active = targetStatuses.filter((s) => s !== 'cancelled' && s !== 'removed')
  if (active.length === 0) return targetStatuses.includes('removed') ? 'removed' : 'cancelled'
  if (active.includes('publishing')) return 'publishing'
  if (active.includes('pending')) return scheduledFor ? 'scheduled' : 'publishing'
  const published = active.filter((s) => s === 'published').length
  if (published === active.length) return 'published'
  return published === 0 ? 'failed' : 'partially_published'
}

/**
 * Recomputes the post's status from its targets. The update only happens when the status actually changes, so of
 * two workers finishing at once only one sees the change and sends the webhook.
 */
export async function refreshPostStatus(scope: TenantScope, postId: string): Promise<Post | null> {
  const [post] = await scope.select(posts, eq(posts.id, postId))
  if (!post) return null
  const targets = await scope.select(postTargets, eq(postTargets.postId, postId))
  const next = rollUpStatus(
    targets.map((t) => t.status),
    post.scheduledFor,
  )
  if (next === post.status) return post
  const [changed] = await scope.update(posts, { status: next, updatedAt: now() }, and(eq(posts.id, postId), sql`${posts.status} <> ${next}`))
  if (!changed) return post
  const type = FINAL_WEBHOOK[next]
  if (type) await notify(scope, changed, type)
  return changed
}

async function notify(scope: TenantScope, post: Post, type: WebhookType): Promise<void> {
  const [view] = await postViews(scope, [post])
  await enqueueWebhook({
    clientId: post.createdByClientId,
    tenantId: post.tenantId,
    type,
    post: {
      id: view!.id,
      status: view!.status,
      source: view!.source,
      source_ref: view!.source_ref,
      targets: view!.targets.map((t) => ({ id: t.id, account_id: t.account_id, status: t.status, permalink: t.permalink, error: t.error })),
    },
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Views

export async function postViews(scope: TenantScope, rows: Post[], opts: { attempts?: boolean } = {}) {
  if (rows.length === 0) return []
  const ids = rows.map((p) => p.id)
  const targets = await scope.select(postTargets, inArray(postTargets.postId, ids), { orderBy: [asc(postTargets.createdAt)] })
  const accountIds = [...new Set(targets.map((t) => t.socialAccountId))]
  const accounts = accountIds.length ? await scope.select(socialAccounts, inArray(socialAccounts.id, accountIds)) : []
  const links = await scope.select(postMedia, inArray(postMedia.postId, ids), { orderBy: [asc(postMedia.position)] })
  const assetIds = [...new Set(links.map((l) => l.mediaAssetId))]
  const assets = assetIds.length ? await scope.select(mediaAssets, inArray(mediaAssets.id, assetIds)) : []
  const jobs = targets.length ? await scope.select(publishJobs, inArray(publishJobs.postTargetId, targets.map((t) => t.id))) : []
  const attempts =
    opts.attempts && targets.length
      ? await scope.select(publishAttempts, inArray(publishAttempts.postTargetId, targets.map((t) => t.id)), { orderBy: [asc(publishAttempts.startedAt)] })
      : []

  return rows.map((post) => ({
    id: post.id,
    tenant_id: post.tenantId,
    caption: post.caption,
    status: post.status,
    scheduled_for: post.scheduledFor,
    source: post.source,
    source_ref: post.sourceRef,
    created_at: post.createdAt,
    updated_at: post.updatedAt,
    media: links
      .filter((l) => l.postId === post.id)
      .map((l) => assets.find((a) => a.id === l.mediaAssetId))
      .filter((a) => a !== undefined)
      .map((a) => ({ id: a.id, url: a.publicUrl, width: a.width, height: a.height })),
    targets: targets
      .filter((t) => t.postId === post.id)
      .map((t) => {
        const account = accounts.find((a) => a.id === t.socialAccountId)
        const job = jobs.find((j) => j.postTargetId === t.id)
        return {
          id: t.id,
          account_id: t.socialAccountId,
          account_name: account?.name ?? null,
          network: account?.network ?? null,
          status: t.status,
          external_post_id: t.externalPostId,
          permalink: t.permalink,
          published_at: t.publishedAt,
          removed_at: t.removedAt,
          error: t.errorMessage ? { code: t.errorCode, message: t.errorMessage } : null,
          attempt_count: job?.attempts ?? 0,
          next_attempt_at: job?.status === 'due' ? job.runAt : null,
          ...(opts.attempts
            ? {
                attempts: attempts
                  .filter((a) => a.postTargetId === t.id)
                  .map((a) => ({
                    id: a.id,
                    started_at: a.startedAt,
                    finished_at: a.finishedAt,
                    outcome: a.outcome,
                    http_status: a.httpStatus,
                    meta_error_code: a.metaErrorCode,
                    meta_error_subcode: a.metaErrorSubcode,
                    message: a.message,
                    external_post_id: a.externalPostId,
                  })),
              }
            : {}),
        }
      }),
  }))
}

export type PostView = Awaited<ReturnType<typeof postViews>>[number]

export async function getPost(scope: TenantScope, id: string): Promise<Post> {
  const [post] = await scope.select(posts, eq(posts.id, id))
  if (!post) throw notFound('Post')
  return post
}

export async function getPostView(scope: TenantScope, id: string, opts: { attempts?: boolean } = {}): Promise<PostView> {
  return (await postViews(scope, [await getPost(scope, id)], opts))[0]!
}

export const listPostsQuery = z.object({
  tenant_id: z.uuid().optional(),
  status: z.enum(POST_STATUSES).optional(),
  source: z.string().max(100).optional(),
  source_ref: z.string().max(200).optional(),
  account_id: z.uuid().optional(),
  created_after: z.iso.datetime({ offset: true }).optional(),
  /** Paging: pass the `created_at` of the last post you got. */
  created_before: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export async function listPosts(scope: TenantScope, q: z.infer<typeof listPostsQuery>): Promise<PostView[]> {
  const where: (SQL | undefined)[] = [
    q.status ? eq(posts.status, q.status) : undefined,
    q.source ? eq(posts.source, q.source) : undefined,
    q.source_ref ? eq(posts.sourceRef, q.source_ref) : undefined,
    q.created_after ? sql`${posts.createdAt} >= ${q.created_after}::timestamptz` : undefined,
    q.created_before ? lt(posts.createdAt, new Date(q.created_before)) : undefined,
    q.account_id
      ? sql`EXISTS (SELECT 1 FROM post_targets pt WHERE pt.post_id = ${posts.id} AND pt.tenant_id = ${scope.tenantId}::uuid AND pt.social_account_id = ${q.account_id}::uuid)`
      : undefined,
  ]
  const rows = await scope.select(posts, and(...where), { orderBy: [desc(posts.createdAt)], limit: q.limit })
  return postViews(scope, rows)
}

// ---------------------------------------------------------------------------------------------------------------
// Create

/** Where a just-created post goes next: "post now" runs right after the response. Set by the publisher. */
let publishSoon: (tenantId: string, postId: string) => Promise<unknown> = async () => undefined
export function onPostNow(fn: typeof publishSoon): void {
  publishSoon = fn
}

export async function createPost(
  scope: TenantScope,
  clientId: string | null,
  key: string,
  input: CreatePostInput,
): Promise<{ status: number; post: PostView; replayed: boolean }> {
  const { tenant_id: _tenant, ...fingerprint } = input
  const hash = requestHash('POST /v1/posts', scope.tenantId, JSON.stringify(fingerprint))
  const owner = clientId ?? '00000000-0000-0000-0000-000000000000'
  const replay = async (previous: StoredResult) => ({
    status: previous.status,
    post: await getPostView(scope, (previous.body as { post_id: string }).post_id),
    replayed: true,
  })
  const previous = clientId ? await previousResult(clientId, key, hash) : null
  if (previous) return replay(previous)

  const caption = input.caption.replace(/\r\n/g, '\n').trim()
  const accountIds = input.account_ids
  const mediaIds = input.media_ids
  if (new Set(accountIds).size !== accountIds.length) throw badRequest('account_ids has duplicates')
  if (new Set(mediaIds).size !== mediaIds.length) throw badRequest('media_ids has duplicates')
  if (!caption && mediaIds.length === 0) throw badRequest('A post needs a caption or at least one image')

  const accounts = await scope.select(socialAccounts, inArray(socialAccounts.id, accountIds))
  if (accounts.length !== accountIds.length) throw badRequest('Unknown account')
  for (const account of accounts) {
    if (account.status !== 'connected') throw new AppError(422, 'AccountNotConnected', `${account.name} needs to be reconnected before posting`)
    const adapter = adapters[account.network]
    if (caption.length > adapter.maxCaptionLength) throw badRequest(`The caption is too long for ${account.name}`)
    if (mediaIds.length > adapter.maxImages) throw badRequest(`${account.name} takes at most ${adapter.maxImages} images`)
  }
  const media = mediaIds.length ? await scope.select(mediaAssets, inArray(mediaAssets.id, mediaIds)) : []
  if (media.length !== mediaIds.length) throw badRequest('Unknown media')

  const at = now()
  const scheduledFor = input.scheduled_for ? new Date(input.scheduled_for) : null
  const runAt = scheduledFor ?? at
  const postId = randomUUID()
  const targets = accountIds.map((accountId) => ({ id: randomUUID(), jobId: randomUUID(), accountId }))
  const status: PostStatus = scheduledFor ? 'scheduled' : 'publishing'
  const iso = at.toISOString()
  const tenant = scope.tenantId

  // One statement, so the idempotency key, the post, its media, targets and jobs exist together or not at all
  // (the Neon HTTP driver has no multi-statement transactions). With a known key, nothing is inserted.
  const keyCte = clientId
    ? sql`INSERT INTO idempotency_keys (client_id, key, request_hash, response_status, response_body)
          VALUES (${owner}::uuid, ${key}, ${hash}, 201, ${JSON.stringify({ post_id: postId })}::jsonb)
          ON CONFLICT DO NOTHING RETURNING 1`
    : sql`SELECT 1`
  const mediaCtes = mediaIds.length
    ? sql`,
      m AS (
        INSERT INTO post_media (post_id, tenant_id, media_asset_id, position)
        SELECT p.id, ${tenant}::uuid, v.media_id, v.pos
        FROM p, (VALUES ${sql.join(
          mediaIds.map((id, i) => sql`(${id}::uuid, ${i}::smallint)`),
          sql`, `,
        )}) AS v(media_id, pos)
        RETURNING 1
      ),
      a AS (
        UPDATE media_assets SET attached_at = ${iso}::timestamptz
        WHERE tenant_id = ${tenant}::uuid AND id IN (${sql.join(
          mediaIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}) AND attached_at IS NULL AND EXISTS (SELECT 1 FROM p)
        RETURNING 1
      )`
    : sql``
  const targetValues = sql.join(
    targets.map((t) => sql`(${t.id}::uuid, ${t.accountId}::uuid, ${t.jobId}::uuid)`),
    sql`, `,
  )
  const result = await getDb().execute(sql`
    WITH k AS (${keyCte}),
    p AS (
      INSERT INTO posts (id, tenant_id, caption, status, scheduled_for, source, source_ref, created_by_client_id, created_at, updated_at)
      SELECT ${postId}::uuid, ${tenant}::uuid, ${caption}, ${status}::post_status, ${scheduledFor?.toISOString() ?? null}::timestamptz,
             ${input.source}, ${input.source_ref ?? null}, ${clientId}::uuid, ${iso}::timestamptz, ${iso}::timestamptz
      FROM k
      RETURNING id
    )${mediaCtes},
    t AS (
      INSERT INTO post_targets (id, tenant_id, post_id, social_account_id, dedupe_marker, created_at, updated_at)
      SELECT v.target_id, ${tenant}::uuid, p.id, v.account_id, ${dedupeMarker(caption)}, ${iso}::timestamptz, ${iso}::timestamptz
      FROM p, (VALUES ${targetValues}) AS v(target_id, account_id, job_id)
      RETURNING 1
    ),
    j AS (
      INSERT INTO publish_jobs (id, tenant_id, post_target_id, run_at, created_at, updated_at)
      SELECT v.job_id, ${tenant}::uuid, v.target_id, ${runAt.toISOString()}::timestamptz, ${iso}::timestamptz, ${iso}::timestamptz
      FROM p, (VALUES ${targetValues}) AS v(target_id, account_id, job_id)
      RETURNING 1
    )
    SELECT id FROM p`)

  if (rowsOf(result).length === 0) {
    // A request with the same key got there first.
    const raced = clientId ? await previousResult(clientId, key, hash) : null
    if (!raced) throw new AppError(500, 'InternalError', 'The post could not be created')
    return replay(raced)
  }
  if (!scheduledFor) runInBackground(`publish ${postId}`, () => publishSoon(tenant, postId))
  return { status: 201, post: await getPostView(scope, postId), replayed: false }
}

// ---------------------------------------------------------------------------------------------------------------
// Cancel, reschedule, retry, take down

/**
 * Cancel (FR-4.5): allowed while every target is still pending. One statement checks and cancels, so it's all or
 * nothing even when a run is starting at the same moment.
 */
export async function cancelPost(scope: TenantScope, postId: string): Promise<PostView> {
  await getPost(scope, postId)
  const result = await getDb().execute(sql`
    WITH bad AS (
      SELECT count(*)::int AS n FROM post_targets t
      LEFT JOIN publish_jobs j ON j.post_target_id = t.id
      WHERE t.post_id = ${postId}::uuid AND t.tenant_id = ${scope.tenantId}::uuid AND (t.status <> 'pending' OR j.status = 'running')
    ),
    t AS (
      UPDATE post_targets SET status = 'cancelled', updated_at = ${now().toISOString()}::timestamptz
      WHERE post_id = ${postId}::uuid AND tenant_id = ${scope.tenantId}::uuid AND status = 'pending' AND (SELECT n FROM bad) = 0
      RETURNING id
    ),
    j AS (
      UPDATE publish_jobs SET status = 'done', locked_until = NULL
      WHERE post_target_id IN (SELECT id FROM t) AND status = 'due'
      RETURNING 1
    )
    SELECT (SELECT n FROM bad) AS bad, (SELECT count(*)::int FROM t) AS cancelled`)
  const row = rowsOf<{ bad: number; cancelled: number }>(result)[0]!
  if (Number(row.bad) > 0) throw conflict('Publishing has already started, so this post can no longer be cancelled')
  await refreshPostStatus(scope, postId)
  return getPostView(scope, postId)
}

/** Reschedule (FR-4.5): same rule as cancel. `null` publishes now. */
export async function reschedulePost(scope: TenantScope, postId: string, scheduledFor: Date | null): Promise<PostView> {
  await getPost(scope, postId)
  const at = now()
  const runAt = scheduledFor ?? at
  const result = await getDb().execute(sql`
    WITH bad AS (
      SELECT count(*)::int AS n FROM post_targets t
      LEFT JOIN publish_jobs j ON j.post_target_id = t.id
      WHERE t.post_id = ${postId}::uuid AND t.tenant_id = ${scope.tenantId}::uuid AND (t.status <> 'pending' OR j.status <> 'due')
    ),
    p AS (
      UPDATE posts SET scheduled_for = ${scheduledFor?.toISOString() ?? null}::timestamptz, updated_at = ${at.toISOString()}::timestamptz
      WHERE id = ${postId}::uuid AND tenant_id = ${scope.tenantId}::uuid AND (SELECT n FROM bad) = 0
      RETURNING id
    ),
    j AS (
      UPDATE publish_jobs SET run_at = ${runAt.toISOString()}::timestamptz, updated_at = ${at.toISOString()}::timestamptz
      WHERE status = 'due' AND EXISTS (SELECT 1 FROM p)
        AND post_target_id IN (SELECT id FROM post_targets WHERE post_id = ${postId}::uuid AND tenant_id = ${scope.tenantId}::uuid)
      RETURNING 1
    )
    SELECT (SELECT n FROM bad) AS bad`)
  if (Number(rowsOf<{ bad: number }>(result)[0]!.bad) > 0) throw conflict('Publishing has already started, so this post can no longer be rescheduled')
  await refreshPostStatus(scope, postId)
  if (!scheduledFor) runInBackground(`publish ${postId}`, () => publishSoon(scope.tenantId, postId))
  return getPostView(scope, postId)
}

/**
 * Admin retry of a failed destination: back to pending with a fresh attempt budget. It checks the Page first, in
 * case an earlier attempt did publish.
 */
export async function retryTarget(scope: TenantScope, postId: string, targetId: string): Promise<PostView> {
  const at = now()
  const [target] = await scope.update(
    postTargets,
    { status: 'pending', errorCode: null, errorMessage: null, updatedAt: at },
    and(eq(postTargets.id, targetId), eq(postTargets.postId, postId), eq(postTargets.status, 'failed')),
  )
  if (!target) throw conflict('Only a failed destination can be retried')
  await scope.update(
    publishJobs,
    { status: 'due', attempts: 0, runAt: at, lockedUntil: null, checkBeforePublish: true, updatedAt: at },
    eq(publishJobs.postTargetId, targetId),
  )
  await refreshPostStatus(scope, postId)
  runInBackground(`publish ${postId}`, () => publishSoon(scope.tenantId, postId))
  return getPostView(scope, postId)
}

/** Takes a published post down from one destination (FR-9.5) and tells the client with `post.taken_down`. */
export async function takeDownTarget(scope: TenantScope, postId: string, targetId: string): Promise<PostView> {
  const post = await getPost(scope, postId)
  const [target] = await scope.select(postTargets, and(eq(postTargets.id, targetId), eq(postTargets.postId, postId)))
  if (!target) throw notFound('Destination')
  if (target.status !== 'published' || !target.externalPostId) throw conflict('Only a published destination can be taken down')
  const [account] = await scope.select(socialAccounts, eq(socialAccounts.id, target.socialAccountId))
  const token = account ? accountToken(account) : null
  if (!account || !token) throw new AppError(422, 'AccountNotConnected', 'Reconnect the account to take this post down')
  try {
    await adapters[account.network].deletePost({ token, externalPostId: target.externalPostId })
  } catch (error) {
    if (error instanceof MetaError) {
      if (error.needsReconnect) await markReconnectNeeded(scope, account.id, error.message)
      throw new AppError(502, 'NetworkError', `Facebook refused the takedown: ${error.message}`)
    }
    throw error
  }
  const at = now()
  await scope.update(postTargets, { status: 'removed', removedAt: at, updatedAt: at }, eq(postTargets.id, targetId))
  const updated = (await refreshPostStatus(scope, postId)) ?? post
  await notify(scope, updated, 'post.taken_down')
  return getPostView(scope, postId)
}
