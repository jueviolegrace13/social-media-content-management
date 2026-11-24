import { createHmac } from 'node:crypto'

/**
 * The one place that talks to Meta's Graph API. Everything Meta-bound goes through `graph()`, which tests replace
 * with `setMetaFetch()`, so no test ever reaches Meta.
 *
 * Errors are classified per ADR-0010:
 * - transient: network failure before the request was sent, Meta 5xx, rate limits, `is_transient`.
 * - permanent: bad or expired token, missing permission, content rejected, anything else Meta refuses.
 * - unknown: the request may have reached Meta but we got no answer (timeout, connection dropped).
 */

export const GRAPH_VERSION = 'v26.0'
export const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`
export const FACEBOOK_DIALOG = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`

const TIMEOUT_MS = 25_000

export type ErrorKind = 'transient' | 'permanent' | 'unknown'

export class MetaError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    message: string,
    public readonly httpStatus: number | null = null,
    public readonly code: number | null = null,
    public readonly subcode: number | null = null,
  ) {
    super(message)
  }

  /** Token invalid or expired, or the person lost their role on the Page: the account must be reconnected. */
  get needsReconnect(): boolean {
    return this.code === 190 || this.code === 102
  }
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>

let metaFetch: FetchFn = (url, init) => fetch(url, init)

/** Test hook: route every Graph API call to a fake. Pass undefined to restore the real fetch. */
export function setMetaFetch(next: FetchFn | undefined): void {
  metaFetch = next ?? ((url, init) => fetch(url, init))
}

/** Rate limits and temporary errors (ADR-0010). */
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 613, 80001])
/** Code 1 ("unknown") with this subcode means the person lacks the "create content" task on the Page. */
const PERMANENT_SUBCODES = new Set([2853006])

export function classifyMetaError(httpStatus: number, body: unknown): MetaError {
  const err = (body as { error?: { message?: string; code?: number; error_subcode?: number; is_transient?: boolean } })?.error
  const code = typeof err?.code === 'number' ? err.code : null
  const subcode = typeof err?.error_subcode === 'number' ? err.error_subcode : null
  const message = redact(err?.message ?? `Meta answered HTTP ${httpStatus}`)
  let kind: ErrorKind = 'permanent'
  if (subcode !== null && PERMANENT_SUBCODES.has(subcode)) kind = 'permanent'
  else if (err?.is_transient === true || (code !== null && TRANSIENT_CODES.has(code)) || httpStatus >= 500 || httpStatus === 429) kind = 'transient'
  return new MetaError(kind, message, httpStatus, code, subcode)
}

/** Connection errors that mean the request never left this machine, so retrying can't double post. */
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'])

function networkError(error: unknown): MetaError {
  const cause = (error as { cause?: { code?: string } })?.cause?.code
  if (cause && NOT_SENT.has(cause)) return new MetaError('transient', `Could not reach Meta (${cause})`)
  const name = (error as { name?: string })?.name
  const what = name === 'TimeoutError' || name === 'AbortError' ? 'Meta did not answer in time' : 'The connection to Meta failed'
  return new MetaError('unknown', what)
}

/** Strips anything that looks like a token or secret from text we store or show. */
export function redact(text: string): string {
  return text
    .replace(/(access_token|client_secret|appsecret_proof|fb_exchange_token|code)=[^&\s"]+/gi, '$1=[redacted]')
    .replace(/\bEA[A-Za-z0-9]{20,}/g, '[redacted]')
    .slice(0, 1000)
}

export interface GraphRequest {
  method?: 'GET' | 'POST' | 'DELETE'
  /** Path after the version, e.g. `/me/accounts`. */
  path: string
  params?: Record<string, string | number | boolean | undefined>
  token?: string
}

/**
 * Calls the Graph API and returns the parsed JSON, or throws a classified `MetaError`. POST parameters go in a form
 * body; GET and DELETE parameters in the query string. When `META_APP_SECRET` is set, every token-carrying call
 * includes `appsecret_proof`, so a leaked token alone can't be used from elsewhere if the app requires it.
 */
export async function graph<T>(req: GraphRequest): Promise<T> {
  const method = req.method ?? 'GET'
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(req.params ?? {})) if (v !== undefined) params.set(k, String(v))
  if (req.token) {
    params.set('access_token', req.token)
    const secret = process.env.META_APP_SECRET
    if (secret) params.set('appsecret_proof', createHmac('sha256', secret).update(req.token).digest('hex'))
  }
  const url = `${GRAPH_BASE}${req.path}`
  const init: RequestInit = { method, signal: AbortSignal.timeout(TIMEOUT_MS) }
  let target = url
  if (method === 'POST') {
    init.body = params
    init.headers = { 'content-type': 'application/x-www-form-urlencoded' }
  } else if ([...params.keys()].length > 0) {
    target = `${url}?${params}`
  }

  let res: Response
  try {
    res = await metaFetch(target, init)
  } catch (error) {
    throw networkError(error)
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    // Meta answered but not with JSON. For a write this means we can't tell whether it took effect.
    throw new MetaError(res.ok ? 'unknown' : res.status >= 500 ? 'transient' : 'permanent', `Meta answered HTTP ${res.status} without JSON`, res.status)
  }
  if (!res.ok || (body as { error?: unknown })?.error) throw classifyMetaError(res.status, body)
  return body as T
}
