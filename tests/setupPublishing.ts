import sharp from 'sharp'
import type { Db } from '../server/db/client'
import { settleBackground } from '../server/lib/background'
import { setFakeClock } from '../server/lib/clock'
import { MemoryStorage, setStorage } from '../server/lib/storage'
import { setMetaFetch } from '../server/networks/metaClient'
import { createApiClient } from '../server/services/apiClients'
import { upsertFacebookPage } from '../server/services/socialAccounts'
import { createTenant } from '../server/services/tenants'
import { setWebhookFetch } from '../server/services/webhooks'
import { FakeMeta } from './fakeMeta'
import { signedRequest, useTestDb } from './helpers'

export interface Webhook {
  url: string
  headers: Record<string, string>
  body: string
  json: { event_id: string; type: string; post: { id: string; status: string; targets: { status: string }[] } }
}

export interface Publishing {
  db: Db
  meta: FakeMeta
  storage: MemoryStorage
  webhooks: Webhook[]
  /** Set to a status code to make the client's webhook endpoint answer with it. */
  webhookStatus: { value: number }
  tenantId: string
  accountId: string
  client: { id: string; secret: string; webhookSecret: string }
  request: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>
  createPost: (body: Record<string, unknown>, key?: string) => Promise<Response>
  close: () => Promise<void>
}

let keyCounter = 0

/** A tenant with a connected Page, a client with every scope and a webhook, fake Meta, memory storage, frozen clock. */
export async function setupPublishing(name = 'open-play'): Promise<Publishing> {
  const { db, close } = await useTestDb()
  const meta = new FakeMeta()
  setMetaFetch(meta.fetch)
  const storage = new MemoryStorage()
  setStorage(storage)
  setFakeClock(new Date())
  const webhooks: Webhook[] = []
  const webhookStatus = { value: 200 }
  setWebhookFetch(async (url, init) => {
    const body = String(init.body)
    webhooks.push({ url, headers: init.headers as Record<string, string>, body, json: JSON.parse(body) })
    return new Response('ok', { status: webhookStatus.value })
  })

  const tenant = await createTenant({ name: 'Open Play platform', kind: 'platform' })
  const account = await upsertFacebookPage(tenant.id, { pageId: '61596641620772', name: 'Open Play PH', pictureUrl: null, token: 'EAAPAGETOKEN0000000000000000000000' }, 'test')
  const created = await createApiClient({
    name,
    scopes: ['accounts:read', 'media:write', 'posts:read', 'posts:write'],
    tenantIds: [tenant.id],
    webhookUrl: 'https://openplay.test/api/integrations/social/webhook',
  })
  const client = { id: created.client.id, secret: created.secret, webhookSecret: created.webhookSecret! }
  const request = (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
    signedRequest(client, method, path, body, { headers })

  return {
    db,
    meta,
    storage,
    webhooks,
    webhookStatus,
    tenantId: tenant.id,
    accountId: account.id,
    client,
    request,
    createPost: (body, key = `key-${++keyCounter}`) =>
      request('POST', '/v1/posts', { account_ids: [account.id], source: 'open_play.roundup', ...body }, { 'idempotency-key': key }),
    close: async () => {
      await settleBackground()
      setMetaFetch(undefined)
      setStorage(undefined)
      setFakeClock(undefined)
      setWebhookFetch(undefined)
      await close()
    },
  }
}

/** A small JPEG carrying EXIF data, to check that uploads strip it. */
export function testJpeg(color = '#ff0000'): Promise<Buffer> {
  return sharp({ create: { width: 40, height: 20, channels: 3, background: color } })
    .jpeg()
    .withExif({ IFD0: { Make: 'TestCam', Model: 'Secret Model' } })
    .toBuffer()
}
