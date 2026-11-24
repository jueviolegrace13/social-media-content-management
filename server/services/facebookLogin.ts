import { createHash, randomBytes } from 'node:crypto'
import { and, eq, lt } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { oauthStates, tenants } from '../db/schema.js'
import { AppError, badRequest, notFound } from '../errors.js'
import { aadFor, decrypt, encrypt } from '../lib/encryption.js'
import { FACEBOOK_DIALOG, graph } from '../networks/metaClient.js'
import { upsertFacebookPage, type SocialAccount } from './socialAccounts.js'

/**
 * A super admin connects a Facebook Page (FR-2.1) through Facebook Login:
 *
 * 1. `start`: a random `state` is stored (hashed) with the admin and tenant, and the browser goes to Facebook.
 * 2. `finish` (Facebook's redirect back): the state must match an unexpired row and the browser's state cookie. The
 *    code becomes a short-lived user token, then a long-lived one, which is stored encrypted with the Page list.
 * 3. `selectPage`: the same admin, signed in again on our origin, picks a Page. Its Page token is fetched fresh,
 *    stored encrypted on the account, and the login row is deleted.
 *
 * The admin cookie is SameSite=Strict, so it isn't sent on Facebook's cross-site redirect; that's why step 3 is a
 * separate same-origin call that checks the admin again.
 */

export const LOGIN_TTL_MINUTES = 15
export const FACEBOOK_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts']

export interface PageChoice {
  id: string
  name: string
  pictureUrl: string | null
  /** False when the person lacks the "create content" task on the Page; publishing would fail (error 1/2853006). */
  canPublish: boolean
}

const hashState = (state: string) => createHash('sha256').update(state).digest('hex')
const userTokenAad = (tenantId: string, rowId: string) => aadFor(tenantId, 'oauth_states.user_token', rowId)

function metaApp(): { appId: string; appSecret: string } {
  const appId = process.env.META_APP_ID ?? ''
  const appSecret = process.env.META_APP_SECRET ?? ''
  if (!appId || !appSecret) throw new AppError(503, 'NotConfigured', 'Facebook Login is not configured (META_APP_ID, META_APP_SECRET)')
  return { appId, appSecret }
}

/** `APP_ORIGIN` when set (must match the URI registered in the Meta app), otherwise the request's own origin. */
export function redirectUri(requestUrl: string): string {
  const origin = process.env.APP_ORIGIN || new URL(requestUrl).origin
  return `${origin}/api/admin/accounts/facebook/callback`
}

export async function startLogin(adminId: string, tenantId: string, redirect: string): Promise<{ url: string; state: string }> {
  const { appId } = metaApp()
  const [tenant] = await getDb().select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId))
  if (!tenant) throw notFound('Tenant')
  const state = randomBytes(32).toString('base64url')
  const now = new Date()
  await getDb().delete(oauthStates).where(lt(oauthStates.expiresAt, now))
  await getDb()
    .insert(oauthStates)
    .values({ stateHash: hashState(state), adminId, tenantId, expiresAt: new Date(now.getTime() + LOGIN_TTL_MINUTES * 60_000) })
  const params = new URLSearchParams({ client_id: appId, redirect_uri: redirect, state, response_type: 'code' })
  // Facebook Login for Business uses a configuration (set up in the Meta app) instead of a scope list.
  const configId = process.env.META_LOGIN_CONFIG_ID
  if (configId) params.set('config_id', configId)
  else params.set('scope', FACEBOOK_SCOPES.join(','))
  return { url: `${FACEBOOK_DIALOG}?${params}`, state }
}

/** Handles Facebook's redirect. Returns the login row ID for the page picker. */
export async function finishLogin(input: { state: string; cookieState: string; code: string; redirect: string }): Promise<string> {
  const { appId, appSecret } = metaApp()
  if (!input.state || input.state !== input.cookieState) throw badRequest('This sign-in link is not valid. Start again.')
  const [row] = await getDb().select().from(oauthStates).where(eq(oauthStates.stateHash, hashState(input.state)))
  if (!row || row.expiresAt < new Date() || row.userTokenCiphertext) throw badRequest('This sign-in link has expired. Start again.')

  const short = await graph<{ access_token: string }>({
    path: '/oauth/access_token',
    params: { client_id: appId, client_secret: appSecret, redirect_uri: input.redirect, code: input.code },
  })
  const long = await graph<{ access_token: string }>({
    path: '/oauth/access_token',
    params: { grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: short.access_token },
  })
  const pages = (await managedPages(long.access_token)).map(({ token: _token, ...page }) => page)

  const enc = encrypt(long.access_token, userTokenAad(row.tenantId, row.id))
  await getDb()
    .update(oauthStates)
    .set({ userTokenKeyVersion: enc.keyVersion, userTokenIv: enc.iv, userTokenCiphertext: enc.ciphertext, userTokenTag: enc.tag, pages })
    .where(eq(oauthStates.id, row.id))
  return row.id
}

async function managedPages(userToken: string): Promise<(PageChoice & { token: string })[]> {
  const res = await graph<{ data: { id: string; name: string; access_token: string; tasks?: string[]; picture?: { data?: { url?: string } } }[] }>({
    path: '/me/accounts',
    params: { fields: 'id,name,access_token,tasks,picture{url}', limit: 100 },
    token: userToken,
  })
  return res.data.map((p) => ({
    id: p.id,
    name: p.name,
    pictureUrl: p.picture?.data?.url ?? null,
    canPublish: !p.tasks || p.tasks.includes('CREATE_CONTENT'),
    token: p.access_token,
  }))
}

async function pendingRow(id: string, adminId: string) {
  const [row] = await getDb()
    .select()
    .from(oauthStates)
    .where(and(eq(oauthStates.id, id), eq(oauthStates.adminId, adminId)))
  if (!row || row.expiresAt < new Date() || !row.userTokenCiphertext) throw notFound('Facebook sign-in')
  return row
}

export async function pendingLogin(id: string, adminId: string): Promise<{ tenantId: string; pages: PageChoice[] }> {
  const row = await pendingRow(id, adminId)
  return { tenantId: row.tenantId, pages: (row.pages as PageChoice[] | null) ?? [] }
}

export async function selectPage(id: string, adminId: string, pageId: string): Promise<SocialAccount> {
  const row = await pendingRow(id, adminId)
  const userToken = decrypt(
    { keyVersion: row.userTokenKeyVersion!, iv: row.userTokenIv!, ciphertext: row.userTokenCiphertext!, tag: row.userTokenTag! },
    userTokenAad(row.tenantId, row.id),
  )
  // Page tokens fetched with a long-lived user token don't expire on a timer (docs/meta-graph-api.md, Tokens).
  const page = (await managedPages(userToken)).find((p) => p.id === pageId)
  if (!page) throw badRequest('That Page is not one you manage')
  const account = await upsertFacebookPage(row.tenantId, { pageId: page.id, name: page.name, pictureUrl: page.pictureUrl, token: page.token }, `admin:${adminId}`)
  await getDb().delete(oauthStates).where(eq(oauthStates.id, row.id))
  return account
}
