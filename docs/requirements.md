# Requirements

Phase 0 output, 2026-11-24. Phases refer to [PLAN.md](../PLAN.md). "Platform" means this app; "client app" means an app
that calls the platform's API (Open Play first).

## Actors

| Actor | Where they work | What they do |
| --- | --- | --- |
| Platform super admin | Platform admin area | Manages tenants, API clients, connected accounts, plans, failed posts |
| Client app (Open Play) | Server to server | Uploads media, creates and schedules posts, receives status webhooks |
| Open Play super admin | Open Play admin area | Daily roundup settings and template, per club post limits, takedowns |
| Club owner | Open Play | Writes leaderboard and session posts; paid tier connects own Page |
| Business user (Phase 6) | Platform web app | Uses the platform directly |
| Meta | External | Publishes posts, returns errors, calls the data deletion endpoint |

## Functional requirements

### FR-1 Tenants and API clients (Phase 1)
1. A tenant is the unit of data isolation: social accounts, posts, media and history all belong to one tenant.
2. The Open Play app is one tenant ("Open Play platform") that owns the dedicated Page. In Phase 5 each paying club gets its own tenant.
3. Super admin can create API clients, scope them (which tenants, which actions), and rotate or revoke their keys. A key is shown once.

### FR-2 Social accounts (Phases 2, 5, 6)
1. Connect a Facebook Page through Facebook Login; store the Page token encrypted.
2. Show account health: connected, reconnect needed, disconnected. A daily check marks failing tokens.
3. Disconnect deletes the stored token. Meta's data deletion callback removes the user's tokens and returns a confirmation code.
4. Network adapters: Facebook Page first, Instagram Business in Phase 6. New networks add an adapter, not new post logic.

### FR-3 Media (Phase 2)
1. Upload JPEG, PNG or WebP images up to 8 MB through the API. The type is checked from the file's bytes, not its name.
2. Images are re-encoded to strip metadata (location, camera data) before storage.
3. Stored in object storage with a public, unguessable URL (Meta fetches media by URL).
4. Media belongs to a tenant and can be reused across posts. Unused uploads are deleted after 7 days.

### FR-4 Posts (Phase 2)
1. A post has a caption, 0 to 10 images, one or more destinations (social accounts), and an optional schedule date.
2. Caption limits are checked per network before accepting (Facebook: 63,206 characters; practical limit set lower in templates).
3. Each destination is tracked separately: one Page can succeed while another fails.
4. Create is idempotent: the same `Idempotency-Key` from the same client returns the original post.
5. Posts can be cancelled or rescheduled until publishing starts.
6. A post records who it's for (`source_ref`, e.g. Open Play club ID) so client apps can filter and enforce limits.

### FR-5 Publishing engine (Phase 2)
1. "Post now" publishes within seconds of the request, without waiting for a scheduled run.
2. Scheduled posts publish in the daily run (2:00 PM PH) on or after their date. See [precise scheduling](plan/later-precise-scheduling.md).
3. A destination is never published twice, even if two runs overlap.
4. Transient errors (Meta 5xx, rate limits, timeouts) retry with backoff, up to 5 attempts. Permanent errors (invalid token,
   permission missing, content rejected) fail immediately with a readable reason.
5. If the outcome of a publish call is unknown (timeout after sending), the engine checks the Page's recent posts before retrying.
6. Every attempt is recorded: time, response code, Meta error code, Meta post ID.
7. Status changes send a signed webhook to the client app, retried until acknowledged (up to 24 hours).

### FR-6 Publishing history (Phase 2)
1. List and view posts by status, destination, date and source, with the Meta post link and error detail.
2. History is kept for 2 years; attempt logs for 90 days.

### FR-7 Super admin, platform (Phases 1, 2)
1. Sign in with password + TOTP. No self sign-up for super admins.
2. Manage tenants, API clients, connected accounts, and view or retry failed posts.
3. Every admin action is written to the audit log.

### FR-8 Open Play: daily roundup (Phase 3, Open Play repo)
1. Daily at 2:00 PM PH, gather that day's planned, publicly listed open plays.
2. Build the caption from an editable template (date, club, venue, time, slots left, event link, club Page link).
3. Skip the day (or post a fallback) when there are no open plays, per setting.
4. Exactly one roundup per date.
5. Open Play super admin can preview, post now, and see each day's status.

### FR-9 Open Play: club posts (Phase 4, Open Play repo)
1. Club owner opens "Create post" from the leaderboard or a completed open play.
2. Caption is prefilled from a template with club name, period, top players and stats; the owner can edit it.
3. Owner uploads photos, previews, then posts now or schedules for a date. Free clubs post to the dedicated Page with no approval.
4. Only players who allow it are named publicly.
5. Per club post limit set by the Open Play super admin; super admin can take down a post.
6. Club owners add their Facebook Page link in club settings.

### FR-10 Paid tier (Phase 5)
1. Club owner connects their own Page through a hosted connect page and returns to Open Play.
2. Destination choice by plan: dedicated Page, own Page, or both.
3. Plans and limits configurable by super admin; billing provider chosen in Phase 5.

## Non-functional requirements

### Security
- Page tokens and other secrets encrypted at rest (AES-256-GCM) with key versioning; keys only in environment variables.
- API keys stored hashed; requests signed and time-limited to block replays.
- Every tenant-owned query is scoped by tenant; automated tests check cross-tenant access is refused.
- Super admin requires TOTP; sessions are httpOnly, Secure, SameSite cookies; sign-in is rate limited.
- No secrets in logs; Meta tokens are redacted from error records.
- Uploaded files validated by content, re-encoded, size limited.
- Security headers (CSP, HSTS, frame-ancestors 'none'); CORS limited to the platform's own origin.

### Reliability
- No double publishing (claimed jobs, unique destination attempt per post).
- A failed run doesn't lose work: due posts stay due until processed.
- Webhooks retried; client apps must treat them as idempotent (each has an event ID).

### Performance
- API responses under 500 ms at p95, excluding upload transfer time.
- Media served from object storage/CDN, not through the API.

### Privacy (Philippine Data Privacy Act basics)
- Only data needed for publishing is stored. Player names reach the platform only inside captions the club chose to post.
- Privacy policy and data deletion endpoint before App Review.
- Disconnecting an account deletes its tokens.

### Cost
- Runs on free tiers: Vercel Hobby, Neon free, a free object storage tier. Design should not require paid services to function.

### Maintainability and extensibility
- Network adapters behind one interface; post model is network-agnostic.
- Versioned API (`/v1`); breaking changes go to a new version.
- No AI dependencies. Captions and media are plain inputs, so AI generation can be added later as another source.

## MVP scope

The MVP is phases 1 to 4: the platform publishes to the dedicated Facebook Page for Open Play's daily roundup and club posts.
Not in the MVP: clubs' own Pages, billing, Instagram, the standalone app, precise scheduling, generated images, analytics, AI.
