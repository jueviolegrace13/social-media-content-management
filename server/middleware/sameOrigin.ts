import { createMiddleware } from 'hono/factory'
import { forbidden } from '../errors.js'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * CSRF backstop on top of the SameSite=Strict admin cookie: a browser request that changes something must come
 * from this origin. Fetch metadata wins when present (so the Vite dev proxy still passes); otherwise the Origin
 * header must match. A request with neither comes from a non-browser client, which can't carry the cookie.
 */
export const sameOrigin = createMiddleware(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next()
  const site = c.req.header('sec-fetch-site')
  const origin = c.req.header('origin')
  const ok = site ? site === 'same-origin' || site === 'none' : origin ? origin === new URL(c.req.url).origin : true
  if (!ok) throw forbidden('Cross-site request blocked')
  await next()
})
