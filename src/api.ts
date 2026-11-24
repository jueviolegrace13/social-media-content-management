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
