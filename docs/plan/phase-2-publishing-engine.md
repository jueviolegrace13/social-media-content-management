# Phase 2: Publishing engine + dedicated Page

**Status:** In progress. Code done on branch `feat/phase-2-publishing-engine` (2026-11-25); waiting on Meta app secret,
redirect URI and R2 setup to publish for real

## Goal

Publish posts to a Facebook Page immediately or at a scheduled time, reliably, with retries, idempotency and a full history. First target: the platform's own dedicated Page.

## Scope

**In:** connecting the dedicated Page (super admin), posts and destinations, media upload, job scheduling, retries, status webhooks to clients, publishing history API.
**Out:** clubs connecting their own Pages (Phase 5), Instagram (Phase 6), end user UI beyond admin.

## Tasks

### Accounts (social)
- [x] Super admin connects a Facebook Page via Facebook Login; Page token stored encrypted
- [x] Token health check and "reconnect needed" status

### Content and media (social)
- [x] `posts`, `post_targets` (one per destination), `media_assets` tables
- [x] Media upload API to object storage: type sniffing, size limits, image re-encoding to strip metadata
- [x] Network-agnostic post model with a per-network adapter (Facebook first) so new networks plug in later

### Publishing (social)
- [x] `POST /v1/posts` with `Idempotency-Key`; publish now or `scheduledAt`
- [x] Job runner per Phase 0 ADR, run by the daily 2:00 PM cron: claims due jobs safely (no double publish), publishes, records result. "Post now" publishes right away without waiting for the cron
- [x] Retry with backoff for transient Meta errors; no retry for permanent errors (bad token, policy rejection)
- [x] Status flow: draft, scheduled, publishing, published, failed, cancelled
- [x] Signed status webhooks to the API client (published, failed) with retries
- [x] Cancel or reschedule before publishing starts

### History and admin (social)
- [x] `GET /v1/posts` and `/v1/posts/:id` with per-destination status, Meta post ID and link, error detail
- [x] Admin screen: recent posts, failures, retry button

### Owner steps (rendee)
- [ ] Add the OAuth redirect URI in the Meta app; add `META_APP_SECRET` and `APP_ORIGIN` in Vercel (README, "Facebook Page connection")
- [ ] Create the Cloudflare R2 bucket and add the five `R2_*` variables in Vercel (README, "Media storage")
- [ ] Connect the dedicated Page in the admin UI and publish a text and a photo post, now and scheduled

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
- 2026-11-25: Built on `feat/phase-2-publishing-engine`. Tested end to end against a fake Graph API (no test calls Meta).
  Decisions:
  - **Images:** `sharp` (libvips) for decoding and re-encoding. It runs on Vercel's Node runtime and the lockfile
    carries the Linux binary. JPEG and PNG keep their type; WebP becomes JPEG (PNG if transparent). EXIF orientation
    is applied, then all metadata dropped. 50-megapixel decode cap against decompression bombs.
  - **Upload size:** the API allows 8 MB (FR-3), but Vercel caps function request bodies at 4.5 MB. Clients resize
    under 4.5 MB for now; presigned direct-to-R2 uploads are the fix if that becomes a problem.
  - **R2 client:** `aws4fetch` (tiny SigV4 signer over fetch) instead of the AWS SDK.
  - **Crons:** kept separate, not combined. Vercel Hobby allows 100 cron jobs per project, each once a day; we use 2.
    The publishing run is `GET /api/cron/run-jobs` (ADR-0005 called it `/internal/run-jobs`), same CRON_SECRET check.
  - **Atomic writes without transactions:** the Neon HTTP driver has none, so creating a post (idempotency key, post,
    media links, targets, jobs) and uploading media (key + asset) are each one SQL statement with data-modifying CTEs.
    Cancel and reschedule check and update in one statement too.
  - **Post now** runs after the response with `waitUntil`, with a 100-second budget: first attempt, and one retry after
    a minute. Later retries (5 minutes, then hourly, picked up by the daily run) up to 5 attempts.
  - **Unknown outcome:** a job whose call timed out, or whose run died (lease expired), is marked "check before
    publish"; the next attempt reads the Page's recent posts since the first attempt and matches a caption hash.
  - **Takedown** adds a `removed` status to targets and posts, and sends `post.taken_down`.
  - **Facebook Login:** the admin cookie is SameSite=Strict, so it isn't sent on Facebook's redirect back. The
    callback checks a hashed `state` stored with the admin and tenant plus a Lax state cookie, stores the long-lived
    user token encrypted, and the admin picks the Page in a normal signed-in call. Added `oauth_states` (planned for
    Phase 5) now. `META_LOGIN_CONFIG_ID` switches to a Facebook Login for Business configuration if needed.
  - **Webhook secrets:** issued when a client gets a webhook URL (on creation or via the admin UI), shown once.
  - `appsecret_proof` is sent with every token-carrying Graph call when `META_APP_SECRET` is set.
