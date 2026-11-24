import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { del, put } from '@vercel/blob'
import { AppError } from '../errors.js'

/**
 * Object storage for media (ADR-0006). Production uses Vercel Blob; tests use memory, `dev:local` a folder on disk.
 * Objects are public by URL (Meta fetches them), under unguessable keys (`t/<tenant>/<uuid>.<ext>`).
 */
export interface MediaStorage {
  /** Stores the object and returns its public URL. */
  put(key: string, body: Uint8Array, contentType: string): Promise<string>
  delete(key: string): Promise<void>
}

/** The Blob SDK calls we use, injectable so tests never reach the network. */
export interface BlobApi {
  put: typeof put
  del: typeof del
}

/**
 * Vercel Blob, public access. The key is the blob pathname as is (no random suffix: the key already holds a UUID), so
 * deleting by key needs no stored URL. Overwrites are refused: keys are never reused.
 */
export class VercelBlobStorage implements MediaStorage {
  constructor(
    private readonly token: string,
    private readonly api: BlobApi = { put, del },
  ) {}

  async put(key: string, body: Uint8Array, contentType: string): Promise<string> {
    const result = await this.api.put(key, Buffer.from(body), {
      access: 'public',
      addRandomSuffix: false,
      contentType,
      cacheControlMaxAge: 31_536_000,
      token: this.token,
    })
    return result.url
  }

  async delete(key: string): Promise<void> {
    await this.api.del(key, { token: this.token })
  }
}

export class MemoryStorage implements MediaStorage {
  readonly objects = new Map<string, { body: Uint8Array; contentType: string }>()
  constructor(private readonly base = 'https://media.test') {}
  async put(key: string, body: Uint8Array, contentType: string) {
    this.objects.set(key, { body, contentType })
    return `${this.base}/${key}`
  }
  async delete(key: string) {
    this.objects.delete(key)
  }
}

/** Local folder, served by `dev:local` at `<base>/<key>`. Meta can't reach it; for trying the UI and API only. */
export class LocalStorage implements MediaStorage {
  constructor(
    private readonly dir: string,
    private readonly base: string,
  ) {}
  private path(key: string) {
    const full = resolve(this.dir, key)
    if (!full.startsWith(resolve(this.dir))) throw new Error('Bad storage key')
    return full
  }
  async put(key: string, body: Uint8Array) {
    const full = this.path(key)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, body)
    return `${this.base}/${key}`
  }
  async delete(key: string) {
    await rm(this.path(key), { force: true })
  }
  filePath(key: string) {
    return join(this.dir, key)
  }
}

let storage: MediaStorage | undefined

export function getStorage(): MediaStorage {
  if (!storage) {
    // Connecting a Blob store to the Vercel project adds this variable automatically.
    const token = process.env.BLOB_READ_WRITE_TOKEN
    if (!token) throw new AppError(503, 'NotConfigured', 'Media storage is not configured')
    storage = new VercelBlobStorage(token)
  }
  return storage
}

/** Test and dev hook: use another storage driver. */
export function setStorage(next: MediaStorage | undefined): void {
  storage = next
}
