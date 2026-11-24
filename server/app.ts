import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'
import { AppError } from './errors.js'
import { sameOrigin } from './middleware/sameOrigin.js'
import { adminRoute } from './routes/admin.js'
import { cronRoute } from './routes/cron.js'
import { v1Route } from './routes/v1.js'

/** JSON bodies are small; media uploads (Phase 2) get their own, larger limit on their route. */
export const MAX_BODY_BYTES = 256 * 1024

const app = new Hono().basePath('/api')

// API responses are JSON only: nothing on them may load content or be framed.
app.use(
  '*',
  secureHeaders({
    xFrameOptions: 'DENY',
    strictTransportSecurity: 'max-age=63072000; includeSubDomains',
    contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
  }),
)

// Browsers may call the API only from the platform's own origin. Client apps call server to server, without CORS.
app.use(
  '*',
  cors({
    origin: (origin, c) => (origin && origin === (process.env.APP_ORIGIN || new URL(c.req.url).origin) ? origin : null),
    credentials: true,
  }),
)

app.use('*', bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: { code: 'PayloadTooLarge', message: 'Request body is too large' } }, 413) }))

app.onError((error, c) => {
  if (error instanceof AppError) {
    return c.json({ error: { code: error.code, message: error.message } }, error.status)
  }
  console.error(error)
  return c.json({ error: { code: 'InternalError', message: 'Something went wrong' } }, 500)
})

app.notFound((c) => c.json({ error: { code: 'NotFound', message: 'Not found' } }, 404))

// The admin area uses a cookie, so its writes must come from this origin.
app.use('/admin/*', sameOrigin)

const routes = app
  .get('/health', (c) => c.json({ ok: true }))
  .route('/v1', v1Route)
  .route('/admin', adminRoute)
  .route('/cron', cronRoute)

export type AppType = typeof routes
export { app }
