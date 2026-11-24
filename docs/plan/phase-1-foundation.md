# Phase 1: Foundation

**Status:** Not started

## Goal

A deployable, tested skeleton of the social app with tenants, client app credentials, super admin access and encrypted secret storage. Security first.

## Scope

**In:** project setup, database and migrations, tenants, API clients (Open Play is the first), super admin sign-in and shell, encryption helpers, audit log, CI.
**Out:** publishing, social account connection, end user UI.

## Tasks

### Project setup (social)
- [ ] Vue 3 + Vite + TS frontend, Hono API on Vercel, Neon + Drizzle, matching Open Play's conventions
- [ ] Lint, typecheck and Vitest; PGlite for DB tests (as Open Play does)
- [ ] GitHub Actions running typecheck + tests on every PR
- [ ] `.env.example`, local dev script, separate Neon branch for dev

### Tenancy and access (social)
- [ ] `tenants` table; every tenant-owned table carries `tenant_id`, and every query goes through a tenant-scoped helper
- [ ] `api_clients` table: hashed keys, scopes, which tenants a client may act for
- [ ] Request authentication for API clients (per ADR from Phase 0), with replay protection
- [ ] Rate limiting per client
- [ ] Tests proving one tenant can't read or change another's data

### Super admin (social)
- [ ] Super admin accounts, sign-in with strong password + TOTP, session handling
- [ ] Admin shell: tenants list, API clients (create, rotate, revoke keys)

### Security building blocks (social)
- [ ] Encryption helper for secrets (key versioning, rotation path), with tests
- [ ] Audit log for admin actions and credential changes
- [ ] Security headers, CORS locked to known origins, request size limits

## Acceptance criteria

- Deployed to Vercel with CI green.
- An Open Play API client can authenticate and call a health/whoami endpoint for its tenant; a bad or replayed request is refused.
- Super admin can sign in with TOTP and manage tenants and API keys.
- Tenant isolation tests pass.

## Depends on

Phase 0 decisions on service auth, encryption and super admin.

## Change log

- 2026-11-24: Phase created.
