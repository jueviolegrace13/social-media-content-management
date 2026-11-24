import { handle } from 'hono/vercel'
import { app } from '../server/app.js'

// Vercel entry. vercel.json rewrites every /api/* request to this one function,
// and Hono routes on the original path.
export default { fetch: handle(app) }
