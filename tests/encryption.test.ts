import { afterEach, describe, expect, it } from 'vitest'
import { aadFor, decrypt, encrypt, generateKey, needsReencrypt, parseKeyRing } from '../server/lib/encryption'

const v1 = generateKey()
const v2 = generateKey()
const original = process.env.ENCRYPTION_KEYS

afterEach(() => {
  process.env.ENCRYPTION_KEYS = original
})

describe('encryption helper', () => {
  it('round-trips with the current key and never stores the plaintext', () => {
    process.env.ENCRYPTION_KEYS = `v1:${v1}`
    const aad = aadFor('t1', 'social_accounts.token', 'row1')
    const value = encrypt('page-token-123', aad)
    expect(value.keyVersion).toBe(1)
    expect(Buffer.from(value.iv, 'base64')).toHaveLength(12)
    expect(value.ciphertext).not.toContain('page-token')
    expect(decrypt(value, aad)).toBe('page-token-123')
  })

  it('uses a fresh IV every time', () => {
    process.env.ENCRYPTION_KEYS = `v1:${v1}`
    const a = encrypt('same', 'aad')
    const b = encrypt('same', 'aad')
    expect(a.iv).not.toBe(b.iv)
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })

  it('refuses a ciphertext moved to another row (AAD binding)', () => {
    process.env.ENCRYPTION_KEYS = `v1:${v1}`
    const value = encrypt('secret', aadFor('t1', 'social_accounts.token', 'row1'))
    expect(() => decrypt(value, aadFor('t1', 'social_accounts.token', 'row2'))).toThrow()
    expect(() => decrypt(value, aadFor('t2', 'social_accounts.token', 'row1'))).toThrow()
  })

  it('refuses tampered ciphertext or tag', () => {
    process.env.ENCRYPTION_KEYS = `v1:${v1}`
    const value = encrypt('secret', 'aad')
    const flipped = Buffer.from(value.ciphertext, 'base64')
    flipped[0] = flipped[0]! ^ 1
    expect(() => decrypt({ ...value, ciphertext: flipped.toString('base64') }, 'aad')).toThrow()
    expect(() => decrypt({ ...value, tag: Buffer.alloc(16).toString('base64') }, 'aad')).toThrow()
  })

  it('rotates: new writes use the first key, old values still decrypt and are flagged', () => {
    process.env.ENCRYPTION_KEYS = `v1:${v1}`
    const old = encrypt('secret', 'aad')
    process.env.ENCRYPTION_KEYS = `v2:${v2},v1:${v1}`
    expect(decrypt(old, 'aad')).toBe('secret')
    expect(needsReencrypt(old)).toBe(true)
    const fresh = encrypt('secret', 'aad')
    expect(fresh.keyVersion).toBe(2)
    expect(needsReencrypt(fresh)).toBe(false)
    // Once the old key is dropped, values still on it can't be read.
    process.env.ENCRYPTION_KEYS = `v2:${v2}`
    expect(() => decrypt(old, 'aad')).toThrow(/v1 is not configured/)
  })

  it('validates the key ring', () => {
    expect(() => parseKeyRing('')).toThrow(/not set/)
    expect(() => parseKeyRing('nope')).toThrow(/v1:<base64 key>/)
    expect(() => parseKeyRing(`v1:${Buffer.alloc(16).toString('base64')}`)).toThrow(/32 bytes/)
    expect(() => parseKeyRing(`v1:${v1},v1:${v2}`)).toThrow(/twice/)
    expect(parseKeyRing(`v3:${v1}, v2:${v2}`).current).toBe(3)
  })
})
