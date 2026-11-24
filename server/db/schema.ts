import { sql } from 'drizzle-orm'
import { index, integer, jsonb, pgEnum, pgTable, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Phase 1 tables (docs/domain-model.md). An encrypted value (ADR-0008) is four columns: the key version and the
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
