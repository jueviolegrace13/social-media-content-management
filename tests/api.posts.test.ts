import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { posts, publishAttempts, publishJobs, socialAccounts } from '../server/db/schema'
import { settleBackground } from '../server/lib/background'
import { forTenant } from '../server/db/tenantScope'
import { advanceClock, now } from '../server/lib/clock'
import { runScheduled } from '../server/routes/cron'
import { createApiClient } from '../server/services/apiClients'
import { claimJobs, runJobs } from '../server/services/publisher'
import { upsertFacebookPage } from '../server/services/socialAccounts'
import { createTenant } from '../server/services/tenants'
import { signedRequest } from './helpers'
import { setupPublishing, testJpeg, type Publishing } from './setupPublishing'

let p: Publishing

beforeEach(async () => {
  p = await setupPublishing()
})

afterEach(async () => {
  await p.close()
})

const MINUTE = 60_000
const DAY = 86_400_000

interface PostBody {
  id: string
  status: string
  targets: { id: string; status: string; external_post_id: string | null; permalink: string | null; error: { code: string; message: string } | null; attempts?: { outcome: string }[] }[]
}

async function json<T = PostBody>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T
}

async function getPost(id: string): Promise<PostBody> {
  return json(p.request('GET', `/v1/posts/${id}`))
}

describe('creating posts', () => {
  it('publishes a text post right away and tells the client', async () => {
    const res = await p.createPost({ caption: "Today's Open Plays" })
    expect(res.status).toBe(201)
    const created = await json(res)
    expect(created.status).toBe('publishing')
    await settleBackground()

    const post = await getPost(created.id)
    expect(post.status).toBe('published')
    expect(post.targets[0]).toMatchObject({ status: 'published', external_post_id: expect.stringMatching(/^61596641620772_/), permalink: expect.stringContaining('facebook.com') })
    expect(p.meta.publishCalls).toHaveLength(1)
    expect(p.meta.publishCalls[0]!.params.get('message')).toBe("Today's Open Plays")
    expect(p.webhooks.map((w) => w.json.type)).toEqual(['post.published'])
    expect(p.webhooks[0]!.json.post.id).toBe(created.id)
  })

  it('publishes a photo post and a multi-photo post', async () => {
    const one = await json<{ id: string; url: string }>(p.request('POST', '/v1/media', new Uint8Array(await testJpeg('#00ff00')), { 'idempotency-key': 'm1' }))
    const two = await json<{ id: string; url: string }>(p.request('POST', '/v1/media', new Uint8Array(await testJpeg('#0000ff')), { 'idempotency-key': 'm2' }))

    await p.createPost({ caption: 'One photo', media_ids: [one.id] })
    await p.createPost({ caption: 'Two photos', media_ids: [one.id, two.id] })
    await settleBackground()

    expect(p.meta.posts.map((x) => [x.message, x.photos])).toEqual(
      expect.arrayContaining([
        ['One photo', [one.url]],
        ['Two photos', [one.url, two.url]],
      ]),
    )
  })

  it('is idempotent: the same key and body create one post', async () => {
    const body = { caption: 'Hello', source_ref: '2026-11-25' }
    const first = await p.createPost(body, 'roundup:2026-11-25')
    const second = await p.createPost(body, 'roundup:2026-11-25')
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect((await json(second)).id).toBe((await json(first)).id)
    await settleBackground()
    expect(await p.db.select().from(posts)).toHaveLength(1)
    expect(p.meta.publishCalls).toHaveLength(1)
  })

  it('refuses the same key with a different body (409)', async () => {
    expect((await p.createPost({ caption: 'Hello' }, 'k')).status).toBe(201)
    const res = await p.createPost({ caption: 'Something else' }, 'k')
    expect(res.status).toBe(409)
    await settleBackground()
    expect(await p.db.select().from(posts)).toHaveLength(1)
  })

  it('requires an idempotency key, a caption or image, and a connected account', async () => {
    const noKey = await p.request('POST', '/v1/posts', { account_ids: [p.accountId], source: 'x', caption: 'a' })
    expect(noKey.status).toBe(400)
    expect((await p.createPost({ caption: '  ' })).status).toBe(400)
    await p.db.update(socialAccounts).set({ status: 'reconnect_needed' })
    expect((await p.createPost({ caption: 'hi' })).status).toBe(422)
  })

  it('refuses a client without the posts:write scope', async () => {
    const reader = await createApiClient({ name: 'reader', scopes: ['posts:read'], tenantIds: [p.tenantId] })
    const res = await signedRequest({ id: reader.client.id, secret: reader.secret }, 'POST', '/v1/posts', { account_ids: [p.accountId], source: 'x', caption: 'a' }, { headers: { 'idempotency-key': 'k' } })
    expect(res.status).toBe(403)
  })
})

describe('scheduled posts and the daily run', () => {
  it('waits for the first run on or after its date', async () => {
    const at = new Date(Date.now() + DAY).toISOString()
    const created = await json(p.createPost({ caption: 'Tomorrow', scheduled_for: at }))
    expect(created.status).toBe('scheduled')

    await runScheduled()
    expect((await getPost(created.id)).status).toBe('scheduled')
    expect(p.meta.publishCalls).toHaveLength(0)

    advanceClock(DAY + MINUTE)
    const run = await runScheduled()
    expect(run).toMatchObject({ processed: 1, published: 1, remaining: 0 })
    expect((await getPost(created.id)).status).toBe('published')
  })

  it('never publishes a destination twice when two runs overlap', async () => {
    const at = new Date(Date.now() + MINUTE).toISOString()
    for (let i = 0; i < 6; i++) await p.createPost({ caption: `Post ${i}`, scheduled_for: at })
    advanceClock(2 * MINUTE)

    const deadline = Date.now() + 10 * MINUTE
    const [a, b] = await Promise.all([runJobs({ deadline }), runJobs({ deadline })])
    expect(a.published + b.published).toBe(6)
    expect(p.meta.publishCalls).toHaveLength(6)
    expect(new Set(p.meta.posts.map((x) => x.message)).size).toBe(6)
  })

  it('puts a job whose run died back in the queue and checks the Page before publishing again', async () => {
    const at = new Date(Date.now() + MINUTE).toISOString()
    const created = await json(p.createPost({ caption: 'Crashed run', scheduled_for: at }))
    advanceClock(2 * MINUTE)
    // A run claims the job, starts its attempt, sends the post, then dies before recording the result.
    const [job] = await claimJobs(10)
    await forTenant(p.db, p.tenantId).insert(publishAttempts, { postTargetId: job!.postTargetId, startedAt: now() })
    p.meta.posts.unshift({ id: '61596641620772_999', pageId: '61596641620772', message: 'Crashed run', created_time: new Date().toISOString(), photos: [] })

    advanceClock(10 * MINUTE)
    const run = await runScheduled()
    expect(run.released).toBe(1)
    const post = await getPost(created.id)
    expect(post.targets[0]).toMatchObject({ status: 'published', external_post_id: '61596641620772_999' })
    expect(p.meta.publishCalls).toHaveLength(0)
  })
})

describe('retries and failures', () => {
  it('retries a transient error and then succeeds', async () => {
    p.meta.failNext = ['transient']
    const created = await json(p.createPost({ caption: 'Retry me' }))
    await settleBackground()
    const post = await getPost(created.id)
    expect(post.status).toBe('published')
    expect(post.targets[0]!.attempts!.map((a) => a.outcome)).toEqual(['transient_error', 'success'])
    expect(p.meta.publishCalls).toHaveLength(2)
  })

  it('leaves later retries to the daily run, with backoff', async () => {
    p.meta.failNext = ['transient', 'rate_limit', 'transient']
    const created = await json(p.createPost({ caption: 'Slow' }))
    await settleBackground()
    // Post now tried twice (now and after 1 minute); the next try waits 5 minutes, past its budget.
    let post = await getPost(created.id)
    expect(post.status).toBe('publishing')
    expect(post.targets[0]!.attempts).toHaveLength(2)

    advanceClock(DAY)
    await runScheduled()
    post = await getPost(created.id)
    expect(post.targets[0]!.attempts).toHaveLength(3)
    advanceClock(DAY)
    await runScheduled()
    post = await getPost(created.id)
    expect(post.status).toBe('published')
    expect(post.targets[0]!.attempts!.map((a) => a.outcome)).toEqual(['transient_error', 'transient_error', 'transient_error', 'success'])
  })

  it('gives up after 5 attempts', async () => {
    p.meta.failNext = Array(10).fill('transient')
    const created = await json(p.createPost({ caption: 'Never' }))
    await settleBackground()
    for (let i = 0; i < 4; i++) {
      advanceClock(DAY)
      await runScheduled()
    }
    const post = await getPost(created.id)
    expect(post.status).toBe('failed')
    expect(post.targets[0]!.attempts).toHaveLength(5)
    expect(post.targets[0]!.error!.message).toMatch(/Gave up after 5 attempts/)
    expect(p.webhooks.map((w) => w.json.type)).toEqual(['post.failed'])
  })

  it('fails a permanent error at once with a readable reason and a webhook', async () => {
    p.meta.failNext = ['permanent']
    const created = await json(p.createPost({ caption: 'Bad content' }))
    await settleBackground()
    const post = await getPost(created.id)
    expect(post.status).toBe('failed')
    expect(post.targets[0]!.error).toEqual({ code: 'meta_100_1349125', message: 'Invalid parameter: content violates policy' })
    expect(post.targets[0]!.attempts).toHaveLength(1)
    expect(p.meta.publishCalls).toHaveLength(1)
    expect(p.webhooks.map((w) => w.json.type)).toEqual(['post.failed'])
    expect(p.webhooks[0]!.json.post.targets[0]!.status).toBe('failed')
    const [job] = await p.db.select().from(publishJobs)
    expect(job!.status).toBe('dead')
  })

  it('marks the account "reconnect needed" on an invalid token', async () => {
    p.meta.failNext = ['token']
    await p.createPost({ caption: 'Expired' })
    await settleBackground()
    const [account] = await p.db.select().from(socialAccounts)
    expect(account!.status).toBe('reconnect_needed')
  })

  it('finds a post whose publish outcome was unknown instead of posting it twice', async () => {
    p.meta.failNext = ['unknown']
    const created = await json(p.createPost({ caption: 'Did it go out?' }))
    await settleBackground()
    const post = await getPost(created.id)
    expect(post.status).toBe('published')
    expect(post.targets[0]!.attempts!.map((a) => a.outcome)).toEqual(['unknown', 'success'])
    expect(p.meta.publishCalls).toHaveLength(1)
    expect(p.meta.posts).toHaveLength(1)
    expect(post.targets[0]!.external_post_id).toBe(p.meta.posts[0]!.id)
  })

  it('records every attempt', async () => {
    p.meta.failNext = ['transient']
    await p.createPost({ caption: 'History' })
    await settleBackground()
    const attempts = await p.db.select().from(publishAttempts)
    expect(attempts.map((a) => [a.outcome, a.metaErrorCode])).toEqual([
      ['transient_error', 2],
      ['success', null],
    ])
    expect(attempts.every((a) => a.finishedAt && !String(a.message ?? '').includes('EAA'))).toBe(true)
  })
})

describe('cancel, reschedule and take down', () => {
  it('cancels a scheduled post and tells the client; never publishes it', async () => {
    const created = await json(p.createPost({ caption: 'Later', scheduled_for: new Date(Date.now() + DAY).toISOString() }))
    const res = await p.request('POST', `/v1/posts/${created.id}/cancel`)
    expect(res.status).toBe(200)
    expect((await json(res)).status).toBe('cancelled')
    await settleBackground()
    expect(p.webhooks.map((w) => w.json.type)).toEqual(['post.cancelled'])

    advanceClock(2 * DAY)
    await runScheduled()
    expect(p.meta.publishCalls).toHaveLength(0)
  })

  it('refuses to cancel once publishing has started', async () => {
    const created = await json(p.createPost({ caption: 'Now' }))
    await settleBackground()
    expect((await p.request('POST', `/v1/posts/${created.id}/cancel`)).status).toBe(409)
  })

  it('reschedules a scheduled post', async () => {
    const created = await json(p.createPost({ caption: 'Move me', scheduled_for: new Date(Date.now() + 5 * DAY).toISOString() }))
    const res = await p.request('POST', `/v1/posts/${created.id}/reschedule`, { scheduled_for: new Date(Date.now() + DAY).toISOString() })
    expect(res.status).toBe(200)
    advanceClock(DAY + MINUTE)
    await runScheduled()
    expect((await getPost(created.id)).status).toBe('published')
  })

  it('takes a published post down', async () => {
    const created = await json(p.createPost({ caption: 'Take me down' }))
    await settleBackground()
    const targetId = (await getPost(created.id)).targets[0]!.id
    const res = await p.request('DELETE', `/v1/posts/${created.id}/targets/${targetId}`)
    expect(res.status).toBe(200)
    const post = await json(res)
    expect(post.status).toBe('removed')
    expect(post.targets[0]!.status).toBe('removed')
    expect(p.meta.posts).toHaveLength(0)
    await settleBackground()
    expect(p.webhooks.map((w) => w.json.type)).toEqual(['post.published', 'post.taken_down'])
    // Only once.
    expect((await p.request('DELETE', `/v1/posts/${created.id}/targets/${targetId}`)).status).toBe(409)
  })
})

describe('history', () => {
  it('lists posts filtered by source_ref and status', async () => {
    await p.createPost({ caption: 'A', source_ref: 'club-1' })
    await p.createPost({ caption: 'B', source_ref: 'club-2', scheduled_for: new Date(Date.now() + DAY).toISOString() })
    await settleBackground()
    const byRef = await json<{ posts: { source_ref: string }[] }>(p.request('GET', '/v1/posts?source_ref=club-1'))
    expect(byRef.posts.map((x) => x.source_ref)).toEqual(['club-1'])
    const scheduled = await json<{ posts: { status: string }[] }>(p.request('GET', '/v1/posts?status=scheduled'))
    expect(scheduled.posts.map((x) => x.status)).toEqual(['scheduled'])
  })

  it('lists the accounts a client may post to, without tokens', async () => {
    const body = await json<{ accounts: Record<string, unknown>[] }>(p.request('GET', '/v1/accounts'))
    expect(body.accounts).toEqual([expect.objectContaining({ id: p.accountId, name: 'Open Play PH', status: 'connected' })])
    expect(JSON.stringify(body)).not.toContain('EAA')
  })
})

describe('tenant isolation', () => {
  it("a client can't read, cancel, or post with another tenant's posts, accounts or media", async () => {
    const created = await json(p.createPost({ caption: 'Mine', scheduled_for: new Date(Date.now() + DAY).toISOString() }))
    const media = await json<{ id: string }>(p.request('POST', '/v1/media', new Uint8Array(await testJpeg()), { 'idempotency-key': 'm' }))

    const other = await createTenant({ name: 'Club B', kind: 'club' })
    const otherAccount = await upsertFacebookPage(other.id, { pageId: '123', name: 'Club B Page', pictureUrl: null, token: 'EAAOTHER000000000000000000000' }, 'test')
    const made = await createApiClient({ name: 'club-b', scopes: ['posts:read', 'posts:write', 'media:write', 'accounts:read'], tenantIds: [other.id] })
    const b = { id: made.client.id, secret: made.secret }

    expect((await signedRequest(b, 'GET', `/v1/posts/${created.id}`)).status).toBe(404)
    expect((await signedRequest(b, 'POST', `/v1/posts/${created.id}/cancel`)).status).toBe(404)
    expect((await signedRequest(b, 'GET', `/v1/posts?tenant_id=${p.tenantId}`)).status).toBe(403)
    expect((await json<{ posts: unknown[] }>(signedRequest(b, 'GET', '/v1/posts'))).posts).toEqual([])
    const accounts = await json<{ accounts: { id: string }[] }>(signedRequest(b, 'GET', '/v1/accounts'))
    expect(accounts.accounts.map((a) => a.id)).toEqual([otherAccount.id])

    // Someone else's account or media can't be used.
    const withAccount = await signedRequest(b, 'POST', '/v1/posts', { account_ids: [p.accountId], source: 'x', caption: 'hi' }, { headers: { 'idempotency-key': 'b1' } })
    expect(withAccount.status).toBe(400)
    const withMedia = await signedRequest(b, 'POST', '/v1/posts', { account_ids: [otherAccount.id], media_ids: [media.id], source: 'x', caption: 'hi' }, { headers: { 'idempotency-key': 'b2' } })
    expect(withMedia.status).toBe(400)

    const [row] = await p.db.select().from(posts).where(eq(posts.id, created.id))
    expect(row!.status).toBe('scheduled')
  })
})
