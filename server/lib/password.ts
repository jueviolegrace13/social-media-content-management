import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'

/** scrypt password hashes (ADR-0009), stored as `scrypt$N$r$p$<salt b64>$<hash b64>`. */

const PARAMS = { N: 2 ** 15, r: 8, p: 1 }
const KEY_LENGTH = 64

function derive(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { ...opts, maxmem: 128 * opts.N! * opts.r! * 2 }, (err, key) =>
      err ? reject(err) : resolve(key),
    )
  })
}

export const MIN_PASSWORD_LENGTH = 14

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await derive(password, salt, PARAMS)
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = stored.split('$')
  if (kind !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64')
  const actual = await derive(password, Buffer.from(salt, 'base64'), { N: Number(n), r: Number(r), p: Number(p) })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** A hash of a random password, compared against when the email is unknown so timing doesn't reveal it. */
let dummy: Promise<string> | undefined
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'))
  return dummy
}
