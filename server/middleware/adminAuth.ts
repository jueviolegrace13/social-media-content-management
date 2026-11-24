import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import { unauthorized } from '../errors.js'
import { adminForSession, deleteAdminSession, SESSION_HOURS, type AdminView } from '../services/admins.js'

export type AdminEnv = { Variables: { admin: AdminView } }

const COOKIE_NAME = 'admin_session'
const COOKIE_PATH = '/api/admin'

/** Secure everywhere except plain-http localhost during development. */
const isSecure = (c: Context) => new URL(c.req.url).protocol === 'https:'

export function setAdminCookie(c: Context, token: string): void {
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    secure: isSecure(c),
    sameSite: 'Strict',
    path: COOKIE_PATH,
    maxAge: SESSION_HOURS * 3600,
  })
}

export async function clearAdminSession(c: Context): Promise<void> {
  const token = getCookie(c, COOKIE_NAME)
  if (token) await deleteAdminSession(token)
  deleteCookie(c, COOKIE_NAME, { path: COOKIE_PATH, secure: isSecure(c) })
}

export const requireAdmin = createMiddleware<AdminEnv>(async (c, next) => {
  const token = getCookie(c, COOKIE_NAME)
  const admin = token ? await adminForSession(token) : null
  if (!admin) throw unauthorized()
  c.set('admin', admin)
  await next()
})
