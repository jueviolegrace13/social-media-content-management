# Phase 2: Publishing engine + dedicated Page

**Status:** Not started

## Goal

Publish posts to a Facebook Page immediately or at a scheduled time, reliably, with retries, idempotency and a full history. First target: the platform's own dedicated Page.

## Scope

**In:** connecting the dedicated Page (super admin), posts and destinations, media upload, job scheduling, retries, status webhooks to clients, publishing history API.
**Out:** clubs connecting their own Pages (Phase 5), Instagram (Phase 6), end user UI beyond admin.

## Tasks

### Accounts (social)
- [ ] Super admin connects a Facebook Page via Facebook Login; Page token stored encrypted
- [ ] Token health check and "reconnect needed" status

### Content and media (social)
- [ ] `posts`, `post_targets` (one per destination), `media_assets` tables
- [ ] Media upload API to object storage: type sniffing, size limits, image re-encoding to strip metadata
- [ ] Network-agnostic post model with a per-network adapter (Facebook first) so new networks plug in later

### Publishing (social)
- [ ] `POST /v1/posts` with `Idempotency-Key`; publish now or `scheduledAt`
- [ ] Job runner per Phase 0 ADR, run by the daily 2:00 PM cron: claims due jobs safely (no double publish), publishes, records result. "Post now" publishes right away without waiting for the cron
- [ ] Retry with backoff for transient Meta errors; no retry for permanent errors (bad token, policy rejection)
- [ ] Status flow: draft, scheduled, publishing, published, failed, cancelled
- [ ] Signed status webhooks to the API client (published, failed) with retries
- [ ] Cancel or reschedule before publishing starts

### History and admin (social)
- [ ] `GET /v1/posts` and `/v1/posts/:id` with per-destination status, Meta post ID and link, error detail
- [ ] Admin screen: recent posts, failures, retry button

## Acceptance criteria

- An API client can publish a text post and a photo post to the dedicated Page, now and scheduled.
- Sending the same request twice with one idempotency key creates one post.
- A forced transient failure retries and then succeeds; a permanent failure ends as failed with a readable reason and a webhook.
- History shows every attempt.

## Depends on

Phase 1. Meta app and dedicated Page created (Phase 0 owner steps).

## Change log

- 2026-11-24: Phase created.
- 2026-11-24: Scheduled posts publish in the once-a-day run for now; see [Later: Precise scheduling](later-precise-scheduling.md).
