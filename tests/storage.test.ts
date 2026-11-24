import { afterEach, describe, expect, it, vi } from 'vitest'
import { getStorage, setStorage, VercelBlobStorage, type BlobApi } from '../server/lib/storage'

function fakeBlob() {
  const api = {
    put: vi.fn(async (pathname: string) => ({ url: `https://store.public.blob.vercel-storage.com/${pathname}` })),
    del: vi.fn(async () => undefined),
  }
  return api
}

describe('VercelBlobStorage', () => {
  it('uploads publicly under the exact key and returns the blob URL', async () => {
    const api = fakeBlob()
    const storage = new VercelBlobStorage('token-1', api as unknown as BlobApi)
    const url = await storage.put('t/tenant/abc.jpg', new Uint8Array([1, 2, 3]), 'image/jpeg')

    expect(url).toBe('https://store.public.blob.vercel-storage.com/t/tenant/abc.jpg')
    expect(api.put).toHaveBeenCalledOnce()
    const [pathname, body, options] = api.put.mock.calls[0] as unknown as [string, Buffer, Record<string, unknown>]
    expect(pathname).toBe('t/tenant/abc.jpg')
    expect([...body]).toEqual([1, 2, 3])
    expect(options).toMatchObject({ access: 'public', addRandomSuffix: false, contentType: 'image/jpeg', token: 'token-1' })
  })

  it('deletes by key', async () => {
    const api = fakeBlob()
    await new VercelBlobStorage('token-1', api as unknown as BlobApi).delete('t/tenant/abc.jpg')
    expect(api.del).toHaveBeenCalledWith('t/tenant/abc.jpg', { token: 'token-1' })
  })

  it('passes upload errors through', async () => {
    const api = fakeBlob()
    api.put.mockRejectedValueOnce(new Error('store unavailable'))
    const storage = new VercelBlobStorage('token-1', api as unknown as BlobApi)
    await expect(storage.put('t/x.jpg', new Uint8Array([1]), 'image/jpeg')).rejects.toThrow('store unavailable')
  })
})

describe('getStorage', () => {
  const original = process.env.BLOB_READ_WRITE_TOKEN
  afterEach(() => {
    setStorage(undefined)
    if (original === undefined) delete process.env.BLOB_READ_WRITE_TOKEN
    else process.env.BLOB_READ_WRITE_TOKEN = original
  })

  it('answers 503 when no Blob store is connected', () => {
    setStorage(undefined)
    delete process.env.BLOB_READ_WRITE_TOKEN
    expect(() => getStorage()).toThrow(expect.objectContaining({ status: 503 }))
  })

  it('uses Vercel Blob when the token is set', () => {
    setStorage(undefined)
    process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_test_token'
    expect(getStorage()).toBeInstanceOf(VercelBlobStorage)
  })
})
