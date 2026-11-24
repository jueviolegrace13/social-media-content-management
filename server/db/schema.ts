import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Tables from docs/domain-model.md (Phase 1: tenancy, clients, admins; Phase 2: accounts, media, posts, jobs). An encrypted value (ADR-0008) is four columns: the key version and the
 * base64 iv, ciphertext and auth tag. Every table holding a tenant's data has `tenant_id` and is read and written
 * through the tenant-scoped helper (server/db/tenantScope.ts).
 */

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

export const TENANT_KINDS = ['platform', 'club', 'business'] as const
export const API_SCOPES = ['accounts:read', 'media:write', 'posts:read', 'posts:write'] as const

export const tenantKind = pgEnum('tenant_kind', TENANT_KINDS)
export const tenantStatus = pgEnum('tenant_status', ['active', 'suspended'])
export const apiClientStatus = pgEnum('api_client_status', ['active', 'revoked'])
export const actorType = pgEnum('actor_type', ['admin', 'client', 'system'])

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  kind: tenantKind('kind').notNull(),
  externalRef: text('external_ref'),
  status: tenantStatus('status').notNull().default('active'),
  createdAt: createdAt(),
})

export const apiClients = pgTable('api_clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  secretKeyVersion: smallint('secret_key_version').notNull(),
  secretIv: text('secret_iv').notNull(),
  secretCiphertext: text('secret_ciphertext').notNull(),
  secretTag: text('secret_tag').notNull(),
  webhookUrl: text('webhook_url'),
  /** Signs status webhooks to this client (ADR-0007). Null until a webhook URL is set. */
  webhookSecretKeyVersion: smallint('webhook_secret_key_version'),
  webhookSecretIv: text('webhook_secret_iv'),
  webhookSecretCiphertext: text('webhook_secret_ciphertext'),
  webhookSecretTag: text('webhook_secret_tag'),
  scopes: text('scopes').array().notNull().default(sql`'{}'::text[]`),
  status: apiClientStatus('status').notNull().default('active'),
  createdAt: createdAt(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
})

export const apiClientTenants = pgTable(
  'api_client_tenants',
  {
    clientId: uuid('client_id')
      .notNull()
      .references(() => apiClients.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.clientId, t.tenantId] }), index('api_client_tenants_tenant_idx').on(t.tenantId)],
)

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    clientId: uuid('client_id')
      .notNull()
      .references(() => apiClients.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.clientId, t.key] }), index('idempotency_keys_created_idx').on(t.createdAt)],
)

export const requestNonces = pgTable(
  'request_nonces',
  {
    clientId: uuid('client_id')
      .notNull()
      .references(() => apiClients.id, { onDelete: 'cascade' }),
    nonce: text('nonce').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.clientId, t.nonce] }), index('request_nonces_created_idx').on(t.createdAt)],
)

export const adminUsers = pgTable('admin_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  totpKeyVersion: smallint('totp_key_version').notNull(),
  totpIv: text('totp_iv').notNull(),
  totpCiphertext: text('totp_ciphertext').notNull(),
  totpTag: text('totp_tag').notNull(),
  /** Last accepted TOTP time step, so one code can't be used twice. */
  totpLastStep: integer('totp_last_step'),
  createdAt: createdAt(),
  lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true }),
})

/** Server-side admin sessions: the cookie holds a random token, the table only its SHA-256. */
export const adminSessions = pgTable(
  'admin_sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    adminId: uuid('admin_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('admin_sessions_admin_idx').on(t.adminId)],
)

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorType: actorType('actor_type').notNull(),
    actorId: text('actor_id'),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    details: jsonb('details'),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [index('audit_log_created_idx').on(t.createdAt), index('audit_log_tenant_idx').on(t.tenantId)],
)

/** Fixed-window rate limit counters, shared by every serverless instance. */
export const rateLimits = pgTable('rate_limits', {
  key: text('key').primaryKey(),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  count: integer('count').notNull(),
})

// ---------------------------------------------------------------------------------------------------------------
// Phase 2: social accounts, media, posts and the publishing queue.

const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()

export const SOCIAL_NETWORKS = ['facebook_page'] as const
export const POST_STATUSES = ['draft', 'scheduled', 'publishing', 'published', 'partially_published', 'failed', 'cancelled', 'removed'] as const
export const TARGET_STATUSES = ['pending', 'publishing', 'published', 'failed', 'cancelled', 'removed'] as const

export const socialNetwork = pgEnum('social_network', SOCIAL_NETWORKS)
export const socialAccountStatus = pgEnum('social_account_status', ['connected', 'reconnect_needed', 'disconnected'])
export const postStatus = pgEnum('post_status', POST_STATUSES)
export const postTargetStatus = pgEnum('post_target_status', TARGET_STATUSES)
export const publishJobStatus = pgEnum('publish_job_status', ['due', 'running', 'done', 'dead'])
export const publishOutcome = pgEnum('publish_outcome', ['success', 'transient_error', 'permanent_error', 'unknown'])
export const webhookStatus = pgEnum('webhook_status', ['pending', 'delivered', 'failed'])

/** A connected destination (a Facebook Page). The token is encrypted (ADR-0008) and removed on disconnect. */
export const socialAccounts = pgTable(
  'social_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    network: socialNetwork('network').notNull(),
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    pictureUrl: text('picture_url'),
    tokenKeyVersion: smallint('token_key_version'),
    tokenIv: text('token_iv'),
    tokenCiphertext: text('token_ciphertext'),
    tokenTag: text('token_tag'),
    status: socialAccountStatus('status').notNull().default('connected'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastError: text('last_error'),
    connectedBy: text('connected_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('social_accounts_tenant_network_external_idx').on(t.tenantId, t.network, t.externalId)],
)

/** An uploaded image, re-encoded and stored in object storage (ADR-0006). `attached_at` null = not used by a post yet. */
export const mediaAssets = pgTable(
  'media_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull().unique(),
    publicUrl: text('public_url').notNull(),
    contentType: text('content_type').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** SHA-256 of the uploaded bytes, to reuse an identical upload within a tenant. */
    sha256: text('sha256').notNull(),
    attachedAt: timestamp('attached_at', { withTimezone: true }),
    createdByClientId: uuid('created_by_client_id').references(() => apiClients.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('media_assets_tenant_sha_idx').on(t.tenantId, t.sha256), index('media_assets_unused_idx').on(t.attachedAt, t.createdAt)],
)

export const posts = pgTable(
  'posts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    caption: text('caption').notNull(),
    /** Rolled up from the targets (docs/domain-model.md, status rules). */
    status: postStatus('status').notNull(),
    /** Null = post now. Otherwise published by the first daily run on or after this time. */
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    source: text('source').notNull(),
    sourceRef: text('source_ref'),
    createdByClientId: uuid('created_by_client_id').references(() => apiClients.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('posts_tenant_created_idx').on(t.tenantId, t.createdAt), index('posts_tenant_source_ref_idx').on(t.tenantId, t.sourceRef)],
)

export const postMedia = pgTable(
  'post_media',
  {
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    mediaAssetId: uuid('media_asset_id')
      .notNull()
      .references(() => mediaAssets.id, { onDelete: 'restrict' }),
    position: smallint('position').notNull(),
  },
  (t) => [primaryKey({ columns: [t.postId, t.position] }), index('post_media_asset_idx').on(t.mediaAssetId)],
)

/** The post on one destination: what users see as published or failed. */
export const postTargets = pgTable(
  'post_targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    postId: uuid('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    socialAccountId: uuid('social_account_id')
      .notNull()
      .references(() => socialAccounts.id, { onDelete: 'restrict' }),
    status: postTargetStatus('status').notNull().default('pending'),
    externalPostId: text('external_post_id'),
    permalink: text('permalink'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    /** Finds this post on the Page when a publish call's outcome is unknown (ADR-0010). */
    dedupeMarker: text('dedupe_marker').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('post_targets_post_account_idx').on(t.postId, t.socialAccountId), index('post_targets_account_idx').on(t.socialAccountId)],
)

/** Queue row for a target (ADR-0005). Separate from the target so queue mechanics stay out of history. */
export const publishJobs = pgTable(
  'publish_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    postTargetId: uuid('post_target_id')
      .notNull()
      .unique()
      .references(() => postTargets.id, { onDelete: 'cascade' }),
    status: publishJobStatus('status').notNull().default('due'),
    runAt: timestamp('run_at', { withTimezone: true }).notNull(),
    attempts: smallint('attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    /** Set after an unknown outcome or a stuck run: look for the post on the Page before publishing again. */
    checkBeforePublish: boolean('check_before_publish').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('publish_jobs_status_run_at_idx').on(t.status, t.runAt)],
)

/** One call to the network and its result. Kept for 90 days. Messages never contain tokens. */
export const publishAttempts = pgTable(
  'publish_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    postTargetId: uuid('post_target_id')
      .notNull()
      .references(() => postTargets.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    outcome: publishOutcome('outcome'),
    httpStatus: integer('http_status'),
    metaErrorCode: integer('meta_error_code'),
    metaErrorSubcode: integer('meta_error_subcode'),
    message: text('message'),
    externalPostId: text('external_post_id'),
  },
  (t) => [index('publish_attempts_target_idx').on(t.postTargetId), index('publish_attempts_started_idx').on(t.startedAt)],
)

/** Signed status webhooks to client apps; `id` is the event_id receivers deduplicate on. */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => apiClients.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    status: webhookStatus('status').notNull().default('pending'),
    attempts: smallint('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
    lastResponseStatus: integer('last_response_status'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => [index('webhook_deliveries_due_idx').on(t.status, t.nextAttemptAt)],
)

/**
 * Facebook Login in progress. Created by a signed-in admin, bound to them and a tenant, valid for 15 minutes.
 * After the callback it holds the encrypted long-lived user token and the Pages to choose from (no Page tokens).
 */
export const oauthStates = pgTable('oauth_states', {
  id: uuid('id').primaryKey().defaultRandom(),
  stateHash: text('state_hash').notNull().unique(),
  adminId: uuid('admin_id')
    .notNull()
    .references(() => adminUsers.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  userTokenKeyVersion: smallint('user_token_key_version'),
  userTokenIv: text('user_token_iv'),
  userTokenCiphertext: text('user_token_ciphertext'),
  userTokenTag: text('user_token_tag'),
  pages: jsonb('pages'),
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})
