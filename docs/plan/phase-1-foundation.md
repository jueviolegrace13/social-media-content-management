# Phase 1: Foundation

**Status:** Complete (2026-11-25)

## Goal

A deployable, tested skeleton of the social app with tenants, client app credentials, super admin access and encrypted secret storage. Security first.

## Scope

**In:** project setup, database and migrations, tenants, API clients (Open Play is the first), super admin sign-in and shell, encryption helpers, audit log, CI.
**Out:** publishing, social account connection, end user UI.

## Tasks

### Project setup (social)
- [x] Vue 3 + Vite + TS frontend, Hono API on Vercel, Neon + Drizzle, matching Open Play's conventions
- [x] Typecheck (`vue-tsc`, strict) and Vitest; PGlite for DB tests (as Open Play does). No separate linter, same as Open Play
- [x] GitHub Actions running typecheck + tests on every PR
- [x] `.env.example`, local dev script (`npm run dev:local` on PGlite, `npm run dev` on Neon)
- [ ] Separate Neon branch for dev (owner: rendee, when the Neon project is created)

### Tenancy and access (social)
- [x] `tenants` table; every tenant-owned table carries `tenant_id`, and every query goes through a tenant-scoped helper (`server/db/tenantScope.ts`)
- [x] `api_clients` table: encrypted secrets (ADR-0007 needs them to verify signatures), scopes, which tenants a client may act for
- [x] Request authentication for API clients (HMAC-SHA256, 5-minute window, nonce replay protection), with `GET /api/v1/whoami`
- [x] Rate limiting per client (Postgres fixed window, shared across instances)
- [x] Tests proving one tenant can't read or change another's data

### Super admin (social)
- [x] Super admin accounts (CLI only), sign-in with scrypt password + TOTP, rate-limited sign-in, server-side sessions in an httpOnly, Secure, SameSite=Strict cookie
- [x] Admin shell at `/admin`: tenants list (create, suspend), API clients (create shows the secret once, rotate, revoke), audit log

### Security building blocks (social)
- [x] Encryption helper for secrets (AES-256-GCM, versioned key ring, AAD row binding, `secrets:reencrypt` rotation script), with tests
- [x] Audit log for admin actions and credential changes
- [x] Security headers (CSP, HSTS, frame-ancestors 'none'), CORS locked to the own origin, request size limit (256 KB)

## Acceptance criteria

- [x] Deployed to Vercel with CI green.
- [x] An Open Play API client can authenticate and call a health/whoami endpoint for its tenant; a bad or replayed request is refused.
- [x] Super admin can sign in with TOTP and manage tenants and API keys.
- [x] Tenant isolation tests pass.

## Depends on

Phase 0 decisions on service auth, encryption and super admin.

## Change log

- 2026-11-24: Phase created.
- 2026-11-25: Built on `feat/phase-1-foundation`: schema and first migration, encryption, signed client API with `whoami`,
  tenant scoping, rate limits, super admin sign-in and admin UI, audit log, security headers, CI. Added `admin_sessions`
  and `rate_limits` tables (see [domain model](../domain-model.md)); webhook secrets wait for Phase 2. Encrypted values
  are stored as base64 text rather than bytea so both database drivers read them the same way.
- 2026-11-25: Deployed to https://social-media-content-management.vercel.app on Vercel Hobby with Neon project
  `patient-sky-34315262` (`main` branch = production). GitHub auto-deploys from `main`. Phase 1 complete.
