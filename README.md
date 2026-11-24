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

Against a Neon dev branch instead: copy `.env.example` to `.env`, fill it in, then `npm run db:migrate` and `npm run dev`.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` / `dev:local` | Vite + API (Neon from `.env` / local PGlite) |
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
server/routes/cron.ts   Daily cleanup (nonces, idempotency keys, sessions, rate limits)
server/db/              Drizzle schema, client, tenant-scoped query helper
server/lib/             Encryption (ADR-0008), request signing (ADR-0007), TOTP, scrypt
server/services/        Tenants, API clients, admins, audit log, rate limits
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

## Deploying

Vercel project with this repo, a Neon database, and these environment variables: `DATABASE_URL`, `ENCRYPTION_KEYS`,
`CRON_SECRET` (and `APP_ORIGIN` if the admin UI is served from another origin). The build runs migrations first
(`vercel-build`). Then create the first admin by running `npm run admin:create` locally with the production `DATABASE_URL` and the
same `ENCRYPTION_KEYS` as production in your shell (the TOTP secret is encrypted with them).
