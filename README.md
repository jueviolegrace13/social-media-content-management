# Social Media Content Management

A social media publishing service for businesses, starting with pickleball clubs. See [PLAN.md](PLAN.md) for what we're
building and where each phase stands, and [`docs/`](docs/) for requirements, decisions and the domain model.

Stack (same as the Open Play app, [ADR-0004](docs/decisions/0004-tech-stack.md)): Vue 3 + Vite + TypeScript (PrimeVue 4,
Tailwind 4, TanStack Query, Pinia), a Hono API as one Vercel Function under `/api`, Neon Postgres + Drizzle, Vitest with
PGlite for database tests.

## Run it locally

```sh
npm install
npm run dev:local   # API on an in-process Postgres stored in ./.local-db, no Neon needed
```

Open http://localhost:5174/admin. The first run creates a local-only admin (`dev@localhost.test` / `local-dev-password`)
and prints its TOTP secret in the terminal; add it to an authenticator app to sign in.

Against a Neon dev branch instead: copy `.env.example` to `.env.local` (or `.env`; `.env.local` wins), fill it in, then `npm run db:migrate` and `npm run dev`.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` / `dev:local` | Vite + API (Neon from `.env.local`/`.env` / local PGlite) |
| `npm run typecheck` | `vue-tsc` over the app, server, scripts and tests |
| `npm test` | Vitest; API tests run against a fresh PGlite with the real migrations |
| `npm run db:generate` | New migration from `server/db/schema.ts` |
| `npm run db:migrate` | Apply migrations to `DATABASE_URL` (also runs on every Vercel build) |
| `npm run admin:create -- <email>` | Create a super admin (the only way; no sign-up screen) |
| `npm run keys:generate` | Print a new encryption key for `ENCRYPTION_KEYS` |
| `npm run secrets:reencrypt` | Key rotation: move every stored secret onto the newest key |

## Layout

```
api/index.ts            Vercel entry; every /api/* request goes to the Hono app
server/app.ts           Middleware (security headers, CORS, body limit) and routes
server/routes/v1.ts     Signed API for client apps (Open Play)
server/routes/admin.ts  Super admin API (cookie session, TOTP sign-in)
server/routes/cron.ts   Daily publishing run and daily cleanup (see "Scheduled jobs")
server/db/              Drizzle schema, client, tenant-scoped query helper
server/lib/             Encryption (ADR-0008), request signing (ADR-0007), TOTP, scrypt, images, storage
server/networks/        Graph API client (the only code that calls Meta) and the Facebook Page adapter
server/services/        Tenants, API clients, admins, audit log, rate limits, accounts, Facebook Login,
                        media, posts, publisher (job runner), webhooks
src/                    Admin UI at /admin
drizzle/                SQL migrations
```

## Calling the API as a client app

Every `/api/v1` request is signed ([ADR-0007](docs/decisions/0007-service-auth.md)):

```
X-Client-Id:  <client id from the admin UI>
X-Timestamp:  <unix seconds; refused if more than 5 minutes off>
X-Nonce:      <16 to 128 chars of [A-Za-z0-9_-], never reused>
X-Signature:  hex(HMAC-SHA256(secret, METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + hex(SHA-256(body))))
```

`PATH` is the path and query string as sent, e.g. `/api/v1/whoami`. The body hash of an empty body is the SHA-256 of
the empty string. `GET /api/v1/whoami` returns the client and the tenants it may act for; see `server/lib/signing.ts`.

## Client API (Phase 2)

All routes are signed as above and need the client's scope. A client linked to one tenant may leave out
`tenant_id`; a client linked to several must send it (query string, or in the body for `POST /v1/posts`).

| Call | Scope | Notes |
| --- | --- | --- |
| `GET /api/v1/accounts` | `accounts:read` | Destinations the tenant can post to |
| `POST /api/v1/media` | `media:write` | Raw JPEG/PNG/WebP bytes, at most 8 MB (but see below). `Idempotency-Key` required |
| `POST /api/v1/posts` | `posts:write` | `{ caption, media_ids, account_ids, scheduled_for, source, source_ref }`. `Idempotency-Key` required |
| `GET /api/v1/posts` | `posts:read` | Filters: `status`, `source`, `source_ref`, `account_id`, `created_after`, `created_before`, `limit` |
| `GET /api/v1/posts/:id` | `posts:read` | Includes every publish attempt per destination |
| `POST /api/v1/posts/:id/cancel` | `posts:write` | While every destination is still pending |
| `POST /api/v1/posts/:id/reschedule` | `posts:write` | `{ scheduled_for }` (`null` = now); same rule as cancel |
| `DELETE /api/v1/posts/:id/targets/:targetId` | `posts:write` | Takes a published post down from one destination |

Same `Idempotency-Key` and same request returns the original result; same key with a different request is `409`.
Keys last 7 days. `scheduled_for: null` publishes within seconds; a date publishes in the first daily run on or
after it.

**Upload size:** the API accepts 8 MB, but Vercel refuses any function request body over 4.5 MB before it reaches
the app. Until uploads move to direct-to-storage, client apps should resize images under 4.5 MB.

### Status webhooks

When a post reaches `published`, `partially_published`, `failed` or `cancelled`, or is taken down, the platform
sends `POST <webhook_url>` to the client that created it, with `{ event_id, type, occurred_at, post }`. Headers:
`X-Event-Id`, `X-Timestamp`, `X-Nonce`, `X-Signature`, where the signature is the same scheme as client requests but
keyed with the client's **webhook secret** and over the webhook URL's own path:
`hex(HMAC-SHA256(webhook_secret, "POST\n" + PATH + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + hex(SHA-256(body))))`.
Answer `2xx` quickly and deduplicate by `event_id`; failures are retried (1, 5, 30 minutes, then by the daily run)
for up to 24 hours. Set the URL in the admin UI (API clients, Webhook); saving it shows the webhook secret once.

## Scheduled jobs

Two Vercel Hobby crons (Hobby allows 100 per project, each once a day, run any time within the scheduled hour):

| Path | Schedule (UTC) | What it does |
| --- | --- | --- |
| `/api/cron/run-jobs` | `0 6 * * *` (2 PM PH) | Puts stuck jobs back, publishes due posts and retries, sends pending webhooks |
| `/api/cron/cleanup` | `0 19 * * *` | Expired nonces/keys/sessions, old attempts (90 days), unused media (7 days), account health check |

"Post now" doesn't wait for the cron: it publishes right after the response (`waitUntil`), retrying once after a
minute. Later retries wait for the next daily run.

## Deploying

Vercel project with this repo, a Neon database, and these environment variables: `DATABASE_URL`, `ENCRYPTION_KEYS`,
`CRON_SECRET`, `APP_ORIGIN`, `META_APP_ID`, `META_APP_SECRET`, and the five `R2_*` variables (see `.env.example`). The build runs migrations first
(`vercel-build`). Then create the first admin by running `npm run admin:create` locally with the production `DATABASE_URL` and the
same `ENCRYPTION_KEYS` as production in your shell (the TOTP secret is encrypted with them).

### Facebook Page connection (Phase 2)

1. In the Meta app (App ID `1805184584083738`), open **Facebook Login for Business** (or Facebook Login) →
   **Settings** and add this **Valid OAuth Redirect URI**:
   `https://social-media-content-management.vercel.app/api/admin/accounts/facebook/callback`.
   For local testing also add `http://localhost:5174/api/admin/accounts/facebook/callback`.
2. In Vercel → Project → Settings → Environment Variables, add `META_APP_SECRET` (Meta app → App settings → Basic →
   App secret) and set `APP_ORIGIN=https://social-media-content-management.vercel.app`. Redeploy.
3. If the app's login only offers configurations (Facebook Login for Business), create one with the permissions
   `pages_show_list`, `pages_read_engagement`, `pages_manage_posts` and set its ID as `META_LOGIN_CONFIG_ID`.
4. In the admin UI: Accounts → Connect a Facebook Page → pick the tenant → sign in with the Facebook account that
   administers the dedicated Page → choose the Page.

### Media storage (Cloudflare R2)

1. Cloudflare dashboard → R2 → create a bucket (e.g. `smcm-media`).
2. Bucket → Settings → Public access: enable the `r2.dev` subdomain (or connect a custom domain). That URL is
   `R2_PUBLIC_BASE_URL`; Meta downloads post images from it.
3. R2 → Manage API tokens → create a token with **Object Read & Write** on that bucket only. Note the Access Key ID
   and Secret Access Key, and your Cloudflare Account ID.
4. Add to Vercel: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL`.
