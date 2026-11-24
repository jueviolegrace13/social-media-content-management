import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { webhookDeliveries } from '../server/db/schema'
import { settleBackground } from '../server/lib/background'
import { advanceClock } from '../server/lib/clock'
import { sign } from '../server/lib/signing'
import { runScheduled } from '../server/routes/cron'
import { setupPublishing, type Publishing } from './setupPublishing'

let p: Publishing

beforeEach(async () => {
  p = await setupPublishing()
})

afterEach(async () => {
  await p.close()
})

describe('status webhooks', () => {
  it('are signed with the client webhook secret, like client requests', async () => {
    await p.createPost({ caption: 'Signed' })
    await settleBackground()
    const hook = p.webhooks[0]!
    expect(hook.url).toBe('https://openplay.test/api/integrations/social/webhook')
    const h = hook.headers
    expect(h['x-event-id']).toBe(hook.json.event_id)
    const expected = sign(p.client.webhookSecret, 'POST', '/api/integrations/social/webhook', h['x-timestamp']!, h['x-nonce']!, hook.body)
    expect(h['x-signature']).toBe(expected)
    // Not the API client secret.
    expect(h['x-signature']).not.toBe(sign(p.client.secret, 'POST', '/api/integrations/social/webhook', h['x-timestamp']!, h['x-nonce']!, hook.body))
  })

  it('are retried with backoff until acknowledged, keeping the same event_id', async () => {
    p.webhookStatus.value = 500
    await p.createPost({ caption: 'Retry the webhook' })
    await settleBackground()
    expect(p.webhooks).toHaveLength(1)
    let [row] = await p.db.select().from(webhookDeliveries)
    expect(row!.status).toBe('pending')
    expect(row!.lastResponseStatus).toBe(500)

    p.webhookStatus.value = 200
    advanceClock(2 * 60_000)
    await runScheduled()
    expect(p.webhooks).toHaveLength(2)
    expect(p.webhooks[1]!.json.event_id).toBe(p.webhooks[0]!.json.event_id)
    // A fresh nonce on each attempt, so receivers that remember nonces don't refuse the retry.
    expect(p.webhooks[1]!.headers['x-nonce']).not.toBe(p.webhooks[0]!.headers['x-nonce'])
    ;[row] = await p.db.select().from(webhookDeliveries)
    expect(row!.status).toBe('delivered')
    expect(row!.attempts).toBe(2)
  })

  it('give up after 24 hours', async () => {
    p.webhookStatus.value = 503
    await p.createPost({ caption: 'Nobody home' })
    await settleBackground()
    advanceClock(25 * 3600_000)
    await runScheduled()
    const [row] = await p.db.select().from(webhookDeliveries)
    expect(row!.status).toBe('failed')
  })
})
