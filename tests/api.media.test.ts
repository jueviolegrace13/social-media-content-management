import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mediaAssets } from '../server/db/schema'
import { settleBackground } from '../server/lib/background'
import { sniffImageType } from '../server/lib/images'
import { cleanup } from '../server/routes/cron'
import { setupPublishing, testJpeg, type Publishing } from './setupPublishing'

let p: Publishing

beforeEach(async () => {
  p = await setupPublishing()
})

afterEach(async () => {
  await p.close()
})

const upload = (bytes: Uint8Array | Buffer, key: string) => p.request('POST', '/v1/media', new Uint8Array(bytes), { 'idempotency-key': key })

describe('media upload', () => {
  it('stores a JPEG re-encoded without its metadata', async () => {
    const original = await testJpeg()
    expect((await sharp(original).metadata()).exif).toBeDefined()

    const res = await upload(original, 'm1')
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string; url: string; width: number; height: number; content_type: string }
    expect(body).toMatchObject({ width: 40, height: 20, content_type: 'image/jpeg' })
    expect(body.url).toMatch(new RegExp(`^https://media\\.test/t/${p.tenantId}/[0-9a-f-]{36}\\.jpg$`))

    const stored = p.storage.objects.get(body.url.replace('https://media.test/', ''))!
    const meta = await sharp(stored.body).metadata()
    expect(meta.exif).toBeUndefined()
    expect(Buffer.from(stored.body).includes('Secret Model')).toBe(false)
  })

  it('keeps PNG as PNG and turns WebP into JPEG', async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } }).png().toBuffer()
    const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#654321' } }).webp().toBuffer()
    expect(((await (await upload(png, 'png')).json()) as { content_type: string }).content_type).toBe('image/png')
    expect(((await (await upload(webp, 'webp')).json()) as { content_type: string }).content_type).toBe('image/jpeg')
  })

  it('checks the type from the bytes, not the header', async () => {
    const res = await upload(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'svg')
    expect(res.status).toBe(415)
    // A GIF claiming to be a JPEG.
    expect((await upload(new TextEncoder().encode('GIF89a....'), 'gif')).status).toBe(415)
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    // Bytes that look like a JPEG but aren't one.
    expect((await upload(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), 'broken')).status).toBe(400)
    expect(p.storage.objects.size).toBe(0)
  })

  it('refuses files over 8 MB', async () => {
    const big = new Uint8Array(8 * 1024 * 1024 + 1)
    big.set([0xff, 0xd8, 0xff])
    expect((await upload(big, 'big')).status).toBe(413)
  })

  it('is idempotent, refuses a reused key for other bytes, and reuses identical uploads', async () => {
    const a = await testJpeg('#ff0000')
    const b = await testJpeg('#00ff00')
    const first = (await (await upload(a, 'media:draft:0')).json()) as { id: string }
    const again = await upload(a, 'media:draft:0')
    expect(again.status).toBe(201)
    expect(((await again.json()) as { id: string }).id).toBe(first.id)
    expect((await upload(b, 'media:draft:0')).status).toBe(409)

    const sameBytesNewKey = await upload(a, 'media:draft:1')
    expect(sameBytesNewKey.status).toBe(200)
    expect(((await sameBytesNewKey.json()) as { id: string }).id).toBe(first.id)
    expect(await p.db.select().from(mediaAssets)).toHaveLength(1)
    expect(p.storage.objects.size).toBe(1)
  })

  it('deletes uploads no post used after 7 days, and keeps used ones', async () => {
    const used = (await (await upload(await testJpeg('#ff0000'), 'u')).json()) as { id: string }
    await upload(await testJpeg('#0000ff'), 'unused')
    await p.createPost({ caption: 'With photo', media_ids: [used.id] })
    await settleBackground()

    expect((await cleanup(new Date(Date.now() + 6 * 86_400_000))).unusedMedia).toBe(0)
    expect((await cleanup(new Date(Date.now() + 8 * 86_400_000))).unusedMedia).toBe(1)
    const left = await p.db.select().from(mediaAssets)
    expect(left.map((m) => m.id)).toEqual([used.id])
    expect(p.storage.objects.size).toBe(1)
  })
})
