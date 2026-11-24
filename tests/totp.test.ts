import { describe, expect, it } from 'vitest'
import { base32Decode, base32Encode, generateTotpSecret, timeStep, totpAt, verifyTotp } from '../server/lib/totp'
import { hashPassword, verifyPassword } from '../server/lib/password'

// RFC 6238 appendix B, SHA-1 seed "12345678901234567890" (8-digit codes there; we use the last 6 digits).
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'))

describe('TOTP', () => {
  it('base32 round-trips', () => {
    const bytes = Buffer.from('any bytes \x00\xff')
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes)
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI')
  })

  it('matches the RFC 6238 test vectors', () => {
    expect(totpAt(RFC_SECRET, Math.floor(59 / 30))).toBe('287082')
    expect(totpAt(RFC_SECRET, Math.floor(1111111109 / 30))).toBe('081804')
    expect(totpAt(RFC_SECRET, Math.floor(1234567890 / 30))).toBe('005924')
    expect(totpAt(RFC_SECRET, Math.floor(2000000000 / 30))).toBe('279037')
  })

  it('accepts the current and adjacent steps only', () => {
    const secret = generateTotpSecret()
    const now = new Date('2026-11-24T10:00:00Z')
    const step = timeStep(now)
    expect(verifyTotp(secret, totpAt(secret, step), null, now)).toBe(step)
    expect(verifyTotp(secret, totpAt(secret, step - 1), null, now)).toBe(step - 1)
    expect(verifyTotp(secret, totpAt(secret, step + 2), null, now)).toBeNull()
    expect(verifyTotp(secret, 'abcdef', null, now)).toBeNull()
  })

  it('refuses a code from a step already used', () => {
    const secret = generateTotpSecret()
    const now = new Date('2026-11-24T10:00:00Z')
    const step = timeStep(now)
    expect(verifyTotp(secret, totpAt(secret, step), step, now)).toBeNull()
  })
})

describe('password hashing', () => {
  it('verifies the right password only', async () => {
    const hash = await hashPassword('correct horse battery')
    expect(hash.startsWith('scrypt$')).toBe(true)
    expect(await verifyPassword('correct horse battery', hash)).toBe(true)
    expect(await verifyPassword('wrong horse battery', hash)).toBe(false)
    expect(await verifyPassword('x', 'garbage')).toBe(false)
  })
})
