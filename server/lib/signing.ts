import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * HMAC-SHA256 request signing (ADR-0007). Client apps sign every request with their secret:
 *
 *   X-Client-Id: <client id>
 *   X-Timestamp: <unix seconds>
 *   X-Nonce:     <random, 16 to 128 chars of [A-Za-z0-9_-]>
 *   X-Signature: hex(HMAC-SHA256(secret, METHOD \n PATH \n TIMESTAMP \n NONCE \n hex(SHA-256(body))))
 *
 * PATH is the request path with its query string, as sent (e.g. `/api/v1/whoami`). The same scheme signs webhooks.
 */

export const MAX_SKEW_SECONDS = 5 * 60
export const NONCE_TTL_SECONDS = 10 * 60
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export function canonicalString(method: string, path: string, timestamp: string, nonce: string, body: string | Uint8Array): string {
  return [method.toUpperCase(), path, timestamp, nonce, sha256Hex(body)].join('\n')
}

export function sign(secret: string, method: string, path: string, timestamp: string, nonce: string, body: string | Uint8Array): string {
  return createHmac('sha256', secret).update(canonicalString(method, path, timestamp, nonce, body)).digest('hex')
}

export function signaturesMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(given.toLowerCase(), 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}
