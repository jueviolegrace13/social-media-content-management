# ADR-0004: Same stack as Open Play

**Status:** Accepted (2026-11-24)

## Context

Open Play runs on Vue 3 + Vite + TypeScript (PrimeVue, Tailwind, TanStack Query, Pinia), a Hono API on Vercel
Functions, and Neon Postgres with Drizzle. One person maintains both apps.

## Decision

Use the same stack and conventions for the platform.

## Consequences

- Shared knowledge, patterns and tooling (Vitest, PGlite tests, Drizzle migrations).
- Vercel Functions are short-lived with no always-on worker, so scheduled publishing needs a cron trigger or hosted
  queue. Vercel Hobby crons run at most once a day; the jobs ADR in Phase 0 decides between Vercel Pro per-minute
  cron and an external scheduler.
- Media goes to object storage, not Postgres (Meta and Instagram fetch media from public URLs).
