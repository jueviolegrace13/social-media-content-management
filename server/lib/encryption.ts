import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * AES-256-GCM for tokens and secrets at rest (ADR-0008).
 *
 * Keys come from `ENCRYPTION_KEYS="v2:<base64>,v1:<base64>"`: the first key encrypts new values, every listed key
 * can decrypt. The AAD binds a value to where it lives (e.g. `-:api_clients.secret:<id>`), so a ciphertext copied
 * into another row or column fails to decrypt.
 *
 * Rotation: put a new key first, run `npm run secrets:reencrypt`, then drop the old key.
 */

export interface Encrypted {
  keyVersion: number
  iv: string
  ciphertext: string
  tag: string
}

interface KeyRing {
  current: number
  keys: Map<number, Buffer>
}

let cached: { source: string; ring: KeyRing } | undefined

export function parseKeyRing(source: string): KeyRing {
  const keys = new Map<number, Buffer>()
  let current: number | undefined
  for (const entry of source.split(',').map((s) => s.trim()).filter(Boolean)) {
    const match = /^v(\d+):(.+)$/.exec(entry)
    if (!match) throw new Error('ENCRYPTION_KEYS entries must look like v1:<base64 key>')
    const version = Number(match[1])
    const key = Buffer.from(match[2]!, 'base64')
    if (key.length !== 32) throw new Error(`Encryption key v${version} must be 32 bytes`)
    if (keys.has(version)) throw new Error(`Encryption key v${version} is listed twice`)
    keys.set(version, key)
    current ??= version
  }
  if (current === undefined) throw new Error('ENCRYPTION_KEYS is not set')
  return { current, keys }
}

function keyRing(): KeyRing {
  const source = process.env.ENCRYPTION_KEYS ?? ''
  if (cached?.source !== source) cached = { source, ring: parseKeyRing(source) }
  return cached.ring
}

/** The AAD for a value: `tenant_id:table.column:row_id`, with `-` for values that belong to no tenant. */
export function aadFor(tenantId: string | null, field: string, rowId: string): string {
  return `${tenantId ?? '-'}:${field}:${rowId}`
}

export function encrypt(plaintext: string, aad: string): Encrypted {
  const ring = keyRing()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', ring.keys.get(ring.current)!, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    keyVersion: ring.current,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  }
}

export function decrypt(value: Encrypted, aad: string): string {
  const key = keyRing().keys.get(value.keyVersion)
  if (!key) throw new Error(`Encryption key v${value.keyVersion} is not configured`)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'))
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8')
}

/** True when the value was written with an older key and should be re-encrypted. */
export function needsReencrypt(value: Pick<Encrypted, 'keyVersion'>): boolean {
  return value.keyVersion !== keyRing().current
}

/** A fresh random key in the format ENCRYPTION_KEYS expects (without the version prefix). */
export function generateKey(): string {
  return randomBytes(32).toString('base64')
}
