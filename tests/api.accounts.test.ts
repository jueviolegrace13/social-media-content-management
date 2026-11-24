import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../server/db/client'
import { socialAccounts } from '../server/db/schema'
import { setMetaFetch } from '../server/networks/metaClient'
import { accountToken, checkAllAccounts } from '../server/services/socialAccounts'
import { createTenant } from '../server/services/tenants'
import { FakeMeta } from './fakeMeta'
import { adminClient, signedInAdmin, useTestDb, type AdminClient } from './helpers'

let db: Db
let close: () => Promise<void>
let meta: FakeMeta
let admin: AdminClient
let tenantId: string
const env = { ...process.env }

beforeEach(async () => {
  ;({ db, close } = await useTestDb())
  meta = new FakeMeta()
  setMetaFetch(meta.fetch)
  process.env.META_APP_ID = '1805184584083738'
  process.env.META_APP_SECRET = 'test-app-secret'
  process.env.APP_ORIGIN = 'https://social.test'
  ;({ admin } = await signedInAdmin())
  tenantId = (await createTenant({ name: 'Open Play platform', kind: 'platform' })).id
})

afterEach(async () => {
  process.env = { ...env }
  setMetaFetch(undefined)
  await close()
})

/** Runs the redirect flow up to Facebook's callback; returns the login ID for the page picker. */
async function connect(as: AdminClient = admin): Promise<{ location: string; stateCookie: string; state: string }> {
  const res = await as.request('GET', `/accounts/facebook/connect?tenantId=${tenantId}`)
  expect(res.status).toBe(302)
  const location = res.headers.get('location')!
  const state = new URL(location).searchParams.get('state')!
  const stateCookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!
  return { location, stateCookie, state }
}

const callback = (query: string, cookie = '') => adminClient(cookie).request('GET', `/accounts/facebook/callback?${query}`)

describe('connecting a Facebook Page', () => {
  it('sends the admin to Facebook with a state, the scopes and our redirect URI', async () => {
    const { location, stateCookie } = await connect()
    const url = new URL(location)
    expect(url.origin + url.pathname).toBe('https://www.facebook.com/v26.0/dialog/oauth')
    expect(url.searchParams.get('client_id')).toBe('1805184584083738')
    expect(url.searchParams.get('redirect_uri')).toBe('https://social.test/api/admin/accounts/facebook/callback')
    expect(url.searchParams.get('scope')).toBe('pages_show_list,pages_read_engagement,pages_manage_posts')
    expect(stateCookie).toMatch(/^fb_login_state=/)
  })

  it('completes the flow and stores the Page token encrypted', async () => {
    const { state, stateCookie } = await connect()
    const back = await callback(`code=good&state=${state}`, stateCookie)
    expect(back.status).toBe(302)
    const loginId = new URL(back.headers.get('location')!, 'https://x').searchParams.get('connect')!
    expect(loginId).toBeTruthy()

    const pending = (await (await admin.request('GET', `/accounts/facebook/pending/${loginId}`)).json()) as { pages: { id: string; canPublish: boolean }[] }
    expect(pending.pages).toEqual([expect.objectContaining({ id: '61596641620772', canPublish: true })])
    expect(JSON.stringify(pending)).not.toContain('EAA')

    const chosen = await admin.request('POST', `/accounts/facebook/pending/${loginId}/select`, { pageId: '61596641620772' })
    expect(chosen.status).toBe(200)
    const [row] = await db.select().from(socialAccounts)
    expect(row).toMatchObject({ tenantId, externalId: '61596641620772', name: 'Open Play PH', status: 'connected' })
    expect(row!.tokenCiphertext).not.toContain('EAAPAGE')
    expect(accountToken(row!)).toBe('EAAPAGETOKEN0000000000000000000000')
    // The login can't be used twice.
    expect((await admin.request('GET', `/accounts/facebook/pending/${loginId}`)).status).toBe(404)
    // Exchanged short for long-lived user token, with the app secret proof on token-carrying calls.
    expect(meta.calls.filter((c) => c.path === '/oauth/access_token').map((c) => c.params.get('grant_type'))).toEqual([null, 'fb_exchange_token'])
    expect(meta.calls.find((c) => c.path === '/me/accounts')!.params.get('appsecret_proof')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses a callback whose state is unknown or not from this browser', async () => {
    const { state, stateCookie } = await connect()
    const wrongCookie = await callback(`code=good&state=${state}`, 'fb_login_state=someone-else')
    expect(wrongCookie.headers.get('location')).toContain('connect_error=failed')
    const forged = await callback('code=good&state=forged', 'fb_login_state=forged')
    expect(forged.headers.get('location')).toContain('connect_error=failed')
    const denied = await callback(`error=access_denied&state=${state}`, stateCookie)
    expect(denied.headers.get('location')).toContain('connect_error=cancelled')
    expect(meta.calls.filter((c) => c.path === '/oauth/access_token')).toHaveLength(0)
  })

  it("another admin can't pick the Page from someone else's login", async () => {
    const { state, stateCookie } = await connect()
    const back = await callback(`code=good&state=${state}`, stateCookie)
    const loginId = new URL(back.headers.get('location')!, 'https://x').searchParams.get('connect')!
    const { admin: other } = await signedInAdmin('other@example.com')
    expect((await other.request('GET', `/accounts/facebook/pending/${loginId}`)).status).toBe(404)
    expect((await other.request('POST', `/accounts/facebook/pending/${loginId}/select`, { pageId: '61596641620772' })).status).toBe(404)
  })

  it('needs a signed-in admin to start, and the app secret configured', async () => {
    expect((await adminClient().request('GET', `/accounts/facebook/connect?tenantId=${tenantId}`)).status).toBe(401)
    delete process.env.META_APP_SECRET
    expect((await admin.request('GET', `/accounts/facebook/connect?tenantId=${tenantId}`)).status).toBe(503)
  })
})

describe('account health', () => {
  async function connected() {
    const { state, stateCookie } = await connect()
    const back = await callback(`code=good&state=${state}`, stateCookie)
    const loginId = new URL(back.headers.get('location')!, 'https://x').searchParams.get('connect')!
    const res = await admin.request('POST', `/accounts/facebook/pending/${loginId}/select`, { pageId: '61596641620772' })
    return ((await res.json()) as { account: { id: string } }).account.id
  }

  it('the daily check refreshes the name and marks a dead token "reconnect needed"; reconnecting fixes it', async () => {
    await connected()
    expect(await checkAllAccounts()).toEqual({ checked: 1, reconnectNeeded: 0 })
    expect((await db.select().from(socialAccounts))[0]!.name).toBe('Open Play PH (renamed)')

    meta.tokenInvalid = true
    expect(await checkAllAccounts()).toEqual({ checked: 1, reconnectNeeded: 1 })
    expect((await db.select().from(socialAccounts))[0]!.status).toBe('reconnect_needed')

    meta.tokenInvalid = false
    await connected()
    const rows = await db.select().from(socialAccounts)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('connected')
  })

  it('disconnect deletes the stored token', async () => {
    const id = await connected()
    expect((await admin.request('POST', `/accounts/${id}/disconnect`)).status).toBe(200)
    const [row] = await db.select().from(socialAccounts)
    expect(row).toMatchObject({ status: 'disconnected', tokenCiphertext: null, tokenIv: null, tokenTag: null, tokenKeyVersion: null })
  })
})
