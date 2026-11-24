import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s steps), the variant every authenticator app supports. */

const STEP_SECONDS = 30
const DIGITS = 6
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of clean) {
    const index = ALPHABET.indexOf(char)
    if (index < 0) throw new Error('Invalid base32')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** A new 160-bit secret, base32 encoded. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

export function timeStep(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000 / STEP_SECONDS)
}

export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const offset = hmac[hmac.length - 1]! & 0x0f
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS
  return code.toString().padStart(DIGITS, '0')
}

/**
 * Checks a code against the current step and one step either side (clock drift). Returns the matching step, or
 * null. Steps at or before `lastStep` are refused, so an accepted code can't be replayed.
 */
export function verifyTotp(secret: string, code: string, lastStep: number | null, now: Date = new Date()): number | null {
  if (!/^\d{6}$/.test(code)) return null
  const current = timeStep(now)
  for (const step of [current - 1, current, current + 1]) {
    if (lastStep !== null && step <= lastStep) continue
    if (timingSafeEqual(Buffer.from(totpAt(secret, step)), Buffer.from(code))) return step
  }
  return null
}

export function otpauthUri(secret: string, account: string, issuer = 'Social Platform Admin'): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
}
