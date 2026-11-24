# Phase 0: Spec and architecture

**Status:** In progress. Docs drafted 2026-11-24, waiting on rendee's review and the owner steps

## Goal

Pin down requirements, confirm what Meta allows, and record the decisions the later phases depend on, before writing app code.

## Scope

**In:** functional and non-functional requirements, Meta API research, remaining architecture decisions, the domain model and first database schema, the Open Play integration contract.
**Out:** any application code.

## Tasks

### Requirements
- [x] Functional requirements per module (accounts, composer, scheduling, media, publishing engine, history, admin, Open Play integration)
- [x] Non-functional requirements: security, tenant isolation, reliability targets, performance, data retention, Philippine Data Privacy Act basics
- [x] MVP vs later scope list, tied to the phases in PLAN.md

### Meta research (record findings in `docs/meta-graph-api.md`)
- [x] Confirm which permissions are needed per phase (`pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, Instagram content publishing)
- [x] Confirm what works in development mode vs what needs App Review and Advanced Access
- [x] Confirm whether a Page post can @mention another Page through the API, and the required feature/permission; define the fallback
- [x] Page token lifetime: long-lived user token to Page token flow, expiry and refresh behavior
- [x] Rate limits and publishing limits for Pages and Instagram
- [ ] Business verification checklist; start it (owner: rendee)
- [ ] Create the Meta app and the dedicated Facebook Page (owner: rendee)

### Decisions (one ADR each in `docs/decisions/`)
- [x] Background jobs: one daily Vercel Hobby cron (2:00 PM PH) drains a Postgres job table; design it so a more frequent trigger can be added later without changes (see [Later: Precise scheduling](later-precise-scheduling.md))
- [x] Confirm Vercel Hobby cron limits for Open Play (it already uses 2 crons) before adding the roundup cron
- [x] Media storage: object storage (Vercel Blob or Cloudflare R2) with public URLs for Meta; Open Play currently stores images as base64 in Postgres, which won't scale here
- [x] Service-to-service auth between Open Play and the social app (API key + HMAC request signing, or OAuth client credentials)
- [x] Secret encryption: envelope encryption of Page tokens (AES-256-GCM, key from env, key version per row)
- [x] Super admin model for each app and how super admins sign in
- [x] Idempotency and retry policy for publishing

### Data and integration
- [x] Domain model and first Drizzle schema draft (`docs/domain-model.md`)
- [x] Open Play integration contract: endpoints, payloads, webhooks for status (`docs/integration-open-play.md`)

## Acceptance criteria

- Requirements, Meta findings, domain model and integration contract are written and reviewed by rendee.
- Every open question in PLAN.md is either answered or has a dated decision to defer it.
- ADRs exist for jobs, media storage, service auth, encryption, super admin and idempotency.

## Depends on

Nothing. The Meta app, dedicated Page and business verification are owner steps that can run alongside.

## Change log

- 2026-11-24: Phase created.
- 2026-11-24: Free tiers only for now; jobs decision must work on Vercel Hobby.
- 2026-11-24: Once-a-day publishing accepted for now; precise scheduling moved to a later plan.
- 2026-11-24: Drafted [requirements](../requirements.md), [Meta findings](../meta-graph-api.md), [domain model](../domain-model.md),
  [Open Play integration](../integration-open-play.md) and ADRs 0005 to 0010. Finding: Page tagging needs App Review + business
  verification, so phases 3 and 4 use the club name and Page link in captions until then.
