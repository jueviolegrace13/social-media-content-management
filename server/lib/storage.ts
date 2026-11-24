import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { AwsClient } from 'aws4fetch'
import { AppError } from '../errors.js'

/**
 * Object storage for media (ADR-0006). Production uses Cloudflare R2 through its S3-compatible API; tests use memory,
 * `dev:local` a folder on disk. Objects are public by URL (Meta fetches them), under unguessable keys.
 */
export interface MediaStorage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>
  delete(key: string): Promise<void>
  publicUrl(key: string): string
}

/** R2 via SigV4-signed fetch (aws4fetch: small, no Node-only dependencies). */
export class R2Storage implements MediaStorage {
  private readonly client: AwsClient
  private readonly endpoint: string

  constructor(
    cfg: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string },
    private readonly publicBase: string,
  ) {
    this.client = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, service: 's3', region: 'auto' })
    this.endpoint = `https://${cfg.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(cfg.bucket)}`
  }

  private url(key: string) {
    return `${this.endpoint}/${key.split('/').map(encodeURIComponent).join('/')}`
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    const res = await this.client.fetch(this.url(key), {
      method: 'PUT',
      body: body as Uint8Array<ArrayBuffer>,
      headers: { 'content-type': contentType, 'cache-control': 'public, max-age=31536000, immutable' },
    })
    if (!res.ok) throw new Error(`Storage upload failed: HTTP ${res.status}`)
  }

  async delete(key: string): Promise<void> {
    const res = await this.client.fetch(this.url(key), { method: 'DELETE' })
    if (!res.ok && res.status !== 404) throw new Error(`Storage delete failed: HTTP ${res.status}`)
  }

  publicUrl(key: string): string {
    return `${this.publicBase.replace(/\/+$/, '')}/${key}`
  }
}

export class MemoryStorage implements MediaStorage {
  readonly objects = new Map<string, { body: Uint8Array; contentType: string }>()
  constructor(private readonly base = 'https://media.test') {}
  async put(key: string, body: Uint8Array, contentType: string) {
    this.objects.set(key, { body, contentType })
  }
  async delete(key: string) {
    this.objects.delete(key)
  }
  publicUrl(key: string) {
    return `${this.base}/${key}`
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
  }
  async delete(key: string) {
    await rm(this.path(key), { force: true })
  }
  publicUrl(key: string) {
    return `${this.base}/${key}`
  }
  filePath(key: string) {
    return join(this.dir, key)
  }
}

let storage: MediaStorage | undefined

export function getStorage(): MediaStorage {
  if (!storage) {
    const env = process.env
    if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET || !env.R2_PUBLIC_BASE_URL) {
      throw new AppError(503, 'NotConfigured', 'Media storage is not configured')
    }
    storage = new R2Storage(
      { accountId: env.R2_ACCOUNT_ID, accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, bucket: env.R2_BUCKET },
      env.R2_PUBLIC_BASE_URL,
    )
  }
  return storage
}

/** Test and dev hook: use another storage driver. */
export function setStorage(next: MediaStorage | undefined): void {
  storage = next
}
