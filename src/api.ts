/** Admin API calls. The session cookie is httpOnly and scoped to /api/admin, so the browser sends it itself. */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export async function adminApi<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/admin${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } }
  if (!res.ok) throw new ApiError(res.status, data.error?.code ?? 'Error', data.error?.message ?? 'Something went wrong')
  return data as T
}

export interface Admin {
  id: string
  email: string
}

export interface Tenant {
  id: string
  name: string
  kind: 'platform' | 'club' | 'business'
  externalRef: string | null
  status: 'active' | 'suspended'
  createdAt: string
}

export interface ApiClient {
  id: string
  name: string
  scopes: string[]
  status: 'active' | 'revoked'
  webhookUrl: string | null
  tenantIds: string[]
  createdAt: string
  rotatedAt: string | null
  revokedAt: string | null
  lastUsedAt: string | null
}

export interface AuditEntry {
  id: string
  actorType: string
  actorId: string | null
  tenantId: string | null
  action: string
  targetType: string | null
  targetId: string | null
  details: Record<string, unknown> | null
  ip: string | null
  createdAt: string
}

export const API_SCOPES = ['accounts:read', 'media:write', 'posts:read', 'posts:write'] as const

export interface SocialAccount {
  id: string
  tenant_id: string
  network: 'facebook_page'
  external_id: string
  name: string
  picture_url: string | null
  status: 'connected' | 'reconnect_needed' | 'disconnected'
  last_checked_at: string | null
  last_error: string | null
}

export interface PageChoice {
  id: string
  name: string
  pictureUrl: string | null
  canPublish: boolean
}

export interface PublishAttempt {
  id: string
  started_at: string
  finished_at: string | null
  outcome: 'success' | 'transient_error' | 'permanent_error' | 'unknown' | null
  http_status: number | null
  meta_error_code: number | null
  meta_error_subcode: number | null
  message: string | null
  external_post_id: string | null
}

export interface PostTarget {
  id: string
  account_id: string
  account_name: string | null
  network: string | null
  status: 'pending' | 'publishing' | 'published' | 'failed' | 'cancelled' | 'removed'
  external_post_id: string | null
  permalink: string | null
  published_at: string | null
  error: { code: string | null; message: string } | null
  attempt_count: number
  next_attempt_at: string | null
  attempts?: PublishAttempt[]
}

export interface Post {
  id: string
  tenant_id: string
  caption: string
  status: 'draft' | 'scheduled' | 'publishing' | 'published' | 'partially_published' | 'failed' | 'cancelled' | 'removed'
  scheduled_for: string | null
  source: string
  source_ref: string | null
  created_at: string
  media: { id: string; url: string; width: number; height: number }[]
  targets: PostTarget[]
}

type Severity = 'success' | 'info' | 'warn' | 'danger' | 'secondary'

export function statusSeverity(status: string): Severity {
  if (status === 'published' || status === 'connected') return 'success'
  if (status === 'failed' || status === 'reconnect_needed') return 'danger'
  if (status === 'partially_published') return 'warn'
  if (status === 'publishing' || status === 'scheduled' || status === 'pending') return 'info'
  return 'secondary'
}

export const label = (status: string) => status.replace(/_/g, ' ')
