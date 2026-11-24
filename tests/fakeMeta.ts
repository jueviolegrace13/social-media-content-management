/**
 * An in-memory stand-in for the Graph API, installed with `setMetaFetch(fake.fetch)`. Tests never reach Meta.
 * Queue failures for the next publish calls with `failNext`.
 */
export type Failure = 'transient' | 'permanent' | 'token' | 'unknown' | 'rate_limit'

export interface FakePost {
  id: string
  pageId: string
  message: string
  created_time: string
  photos: string[]
}

export class FakeMeta {
  calls: { method: string; path: string; params: URLSearchParams }[] = []
  posts: FakePost[] = []
  photos = new Map<string, string>()
  failNext: Failure[] = []
  /** When true, health checks and reads answer "invalid token". */
  tokenInvalid = false
  pages = [{ id: '61596641620772', name: 'Open Play PH', access_token: 'EAAPAGETOKEN0000000000000000000000', tasks: ['CREATE_CONTENT', 'MANAGE'] }]
  private n = 0

  get publishCalls() {
    return this.calls.filter((c) => c.method === 'POST' && (c.path.endsWith('/feed') || (c.path.endsWith('/photos') && c.params.get('published') !== 'false')))
  }

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url)
    const method = (init.method ?? 'GET').toUpperCase()
    const params = method === 'POST' ? new URLSearchParams(init.body as URLSearchParams) : u.searchParams
    const path = u.pathname.replace(/^\/v\d+\.\d+/, '')
    this.calls.push({ method, path, params })
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const fail = (f: Failure): Response => {
      if (f === 'transient') return json(500, { error: { message: 'An unexpected error has occurred. Please retry your request later.', code: 2, is_transient: true } })
      if (f === 'rate_limit') return json(400, { error: { message: 'Application request limit reached', code: 4 } })
      if (f === 'token') return json(400, { error: { message: 'Error validating access token: Session has expired', code: 190, error_subcode: 463 } })
      return json(400, { error: { message: 'Invalid parameter: content violates policy', code: 100, error_subcode: 1349125 } })
    }
    const page = path.split('/')[1] ?? ''

    if (path === '/oauth/access_token') {
      if (params.get('code') === 'bad-code') return json(400, { error: { message: 'Invalid verification code format.', code: 100 } })
      return json(200, { access_token: params.get('grant_type') ? 'EAALONGUSERTOKEN0000000000000000' : 'EAASHORTUSERTOKEN00000000000000', token_type: 'bearer' })
    }
    if (path === '/me/accounts') {
      return json(200, { data: this.pages.map((p) => ({ ...p, picture: { data: { url: `https://pic.test/${p.id}.jpg` } } })) })
    }

    const isPublish = method === 'POST' && (path.endsWith('/feed') || (path.endsWith('/photos') && params.get('published') !== 'false'))
    if (isPublish) {
      const f = this.failNext.shift()
      if (f && f !== 'unknown') return fail(f)
      const id = `${page}_${++this.n}`
      const photos = path.endsWith('/photos')
        ? [params.get('url')!]
        : [...params.entries()].filter(([k]) => k.startsWith('attached_media')).map(([, v]) => this.photos.get(JSON.parse(v).media_fbid)!)
      this.posts.unshift({ id, pageId: page, message: params.get('message') ?? '', created_time: new Date().toISOString(), photos })
      if (f === 'unknown') {
        // The post went out, but the answer never came back.
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      }
      return json(200, path.endsWith('/photos') ? { id: `photo${this.n}`, post_id: id } : { id })
    }
    if (method === 'POST' && path.endsWith('/photos')) {
      const id = `photo${++this.n}`
      this.photos.set(id, params.get('url')!)
      return json(200, { id })
    }
    if (method === 'GET' && path.endsWith('/posts')) {
      if (this.tokenInvalid) return fail('token')
      const since = Number(params.get('since') ?? 0) * 1000
      return json(200, { data: this.posts.filter((p) => p.pageId === page && new Date(p.created_time).getTime() >= since).map((p) => ({ ...p, permalink_url: `https://facebook.com/${p.id}` })) })
    }
    if (method === 'DELETE') {
      const before = this.posts.length
      this.posts = this.posts.filter((p) => p.id !== page)
      return before === this.posts.length ? json(400, { error: { message: 'Unsupported delete request.', code: 100 } }) : json(200, { success: true })
    }
    if (method === 'GET' && params.get('fields') === 'permalink_url') return json(200, { id: page, permalink_url: `https://facebook.com/${page}` })
    if (method === 'GET' && params.get('fields')?.startsWith('id,name')) {
      if (this.tokenInvalid) return fail('token')
      return json(200, { id: page, name: 'Open Play PH (renamed)', picture: { data: { url: 'https://pic.test/new.jpg' } } })
    }
    return json(404, { error: { message: `Fake Meta has no route for ${method} ${path}`, code: 803 } })
  }
}
