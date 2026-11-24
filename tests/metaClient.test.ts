import { afterEach, describe, expect, it } from 'vitest'
import { classifyMetaError, graph, MetaError, redact, setMetaFetch } from '../server/networks/metaClient'

afterEach(() => setMetaFetch(undefined))

const err = (code: number, extra: Record<string, unknown> = {}) => ({ error: { message: 'x', code, ...extra } })

describe('Meta error classes (ADR-0010)', () => {
  it('treats rate limits, 5xx and is_transient as transient', () => {
    for (const code of [4, 17, 32, 613, 80001]) expect(classifyMetaError(400, err(code)).kind).toBe('transient')
    expect(classifyMetaError(500, {}).kind).toBe('transient')
    expect(classifyMetaError(400, err(9000, { is_transient: true })).kind).toBe('transient')
  })

  it('treats bad tokens, missing permissions and rejected content as permanent', () => {
    expect(classifyMetaError(400, err(190)).needsReconnect).toBe(true)
    for (const code of [10, 200, 100, 368]) expect(classifyMetaError(400, err(code)).kind).toBe('permanent')
    // Missing "create content" task on the Page.
    expect(classifyMetaError(400, err(1, { error_subcode: 2853006 })).kind).toBe('permanent')
  })

  it('separates "never sent" from "maybe sent"', async () => {
    setMetaFetch(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    })
    await expect(graph({ method: 'POST', path: '/1/feed' })).rejects.toMatchObject({ kind: 'transient' })
    setMetaFetch(async () => {
      throw new DOMException('timeout', 'TimeoutError')
    })
    await expect(graph({ method: 'POST', path: '/1/feed' })).rejects.toMatchObject({ kind: 'unknown' })
  })

  it('never keeps tokens in messages', () => {
    expect(redact('bad url ?access_token=EAAB123&x=1 and EAABCDEFGHIJKLMNOPQRSTUVWXYZ0123')).toBe('bad url ?access_token=[redacted]&x=1 and [redacted]')
    const e = classifyMetaError(400, { error: { message: 'Invalid OAuth access token EAAxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', code: 190 } })
    expect(e).toBeInstanceOf(MetaError)
    expect(e.message).not.toContain('EAAxxx')
  })
})
