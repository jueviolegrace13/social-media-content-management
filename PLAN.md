# Plan: Social Media Content Management Platform

This is the base plan: what we're building, the order we build it in, and where each phase stands.
Each phase has its own file under [`docs/plan/`](docs/plan/) that holds its tasks, acceptance criteria and change log.
Architecture decisions live in [`docs/decisions/`](docs/decisions/). Reference docs: [requirements](docs/requirements.md),
[Meta Graph API findings](docs/meta-graph-api.md), [domain model](docs/domain-model.md), [Open Play integration](docs/integration-open-play.md).

**How to use this plan**
- This file stays short. Detail and changes go in the phase file, not here.
- A phase is marked `[x]` here only when every acceptance criterion in its phase file is met.
- When a phase's scope changes, record it in that phase file's *Change log* and update the one-line summary here if it no longer fits.

## What we're building

A social media publishing service for businesses, starting with pickleball clubs. It connects social accounts
(Facebook Pages first, then Instagram Business), lets users compose posts with media, schedules and publishes them
reliably, and keeps a publishing history.

It's a **separate app** with its own API. Its first and most important client is the
[Open Play app](https://github.com/jueviolegrace13/open-play-management), which turns club activity
(daily open plays, leaderboards) into posts without retyping anything.

No AI features in the first release. The design keeps room for them later.

### Who uses it, in order

1. **The Open Play app itself:** posts a daily "Today's Open Plays" roundup to the platform's dedicated Facebook Page.
2. **Open Play club owners:** post leaderboards and top players to the dedicated Page, tagging their own Page.
   A paid tier (discounted for Open Play clubs) posts to the club's own Page instead.
3. **External paying businesses** (gyms, facilities, event organizers): use the platform directly.

### Key decisions so far

| Decision | Summary | Record |
| --- | --- | --- |
| Separate app, API first | Own deployment and database; Open Play talks to it over an authenticated API | [ADR-0001](docs/decisions/0001-separate-app-api-first.md) |
| Native composer, not an iframe | Open Play builds its own posting screens and calls the API server to server | [ADR-0002](docs/decisions/0002-native-composer-not-iframe.md) |
| Content is assembled by the source app | Open Play owns open play data and templates; the platform owns publishing | [ADR-0003](docs/decisions/0003-source-app-assembles-content.md) |
| Same stack as Open Play | Vue 3 + Vite + TS, Hono on Vercel, Neon Postgres + Drizzle | [ADR-0004](docs/decisions/0004-tech-stack.md) |
| Jobs on free hosting | Postgres job table, daily cron, "post now" runs inline | [ADR-0005](docs/decisions/0005-background-jobs.md) |
| Media storage | Vercel Blob (one platform, public URLs for Meta) | [ADR-0006](docs/decisions/0006-media-storage.md) |
| App-to-app auth | HMAC-signed requests and webhooks | [ADR-0007](docs/decisions/0007-service-auth.md) |
| Token encryption | AES-256-GCM, versioned key ring | [ADR-0008](docs/decisions/0008-secret-encryption.md) |
| Super admins | Separate per app, TOTP required | [ADR-0009](docs/decisions/0009-super-admin.md) |
| Idempotency and retries | Idempotency keys, error classes, no double publish | [ADR-0010](docs/decisions/0010-idempotency-and-retries.md) |

### Meta constraints that shape the plan

- Posting to **a Page we manage ourselves** works while the Meta app is in development mode, so phases 1 to 4 don't wait on App Review.
- Posting to **other people's Pages** (paid tier) needs Facebook Login, `pages_manage_posts` with Advanced Access, App Review and business verification. Verification waits on registering the business (Phase 5).
- **Tagging other Pages** needs the Page Mentioning feature, which needs App Review and business verification. Without it, tags are silently stripped. Until then, posts use the club's name and Page link in the caption ([findings](docs/meta-graph-api.md)).
- **Instagram** only publishes from Business/Creator accounts linked to a Page, needs an image or video on every post, fetches media from a public URL, and caps publishing (about 50 posts per 24 hours).
- Meta charges nothing for the API, App Review or verification.

## Phases

| | Phase | Outcome | Repo(s) |
| --- | --- | --- | --- |
| [x] | [0. Spec and architecture](docs/plan/phase-0-spec-and-architecture.md) | Requirements, Meta findings, remaining decisions recorded | social |
| [x] | [1. Foundation](docs/plan/phase-1-foundation.md) | App skeleton, tenants, client API keys, super admin, encrypted secrets | social |
| [ ] | [2. Publishing engine + dedicated Page](docs/plan/phase-2-publishing-engine.md) | Publish now or scheduled to a Facebook Page, with retries and history | social |
| [ ] | [3. Daily "Today's Open Plays"](docs/plan/phase-3-daily-open-plays.md) | Open Play posts a daily roundup at 2:00 PM PH time | open-play, social |
| [ ] | [4. Club leaderboard posts](docs/plan/phase-4-club-posts.md) | Club owners compose leaderboard posts in Open Play for the dedicated Page | open-play, social |
| [ ] | [5. Paid tier: clubs' own Pages](docs/plan/phase-5-paid-club-pages.md) | Clubs connect their Page and post there; plans and billing | open-play, social |
| [ ] | [6. Standalone app for external businesses](docs/plan/phase-6-standalone-app.md) | Dashboard, composer, calendar, media library, Instagram | social |

**Later (not scheduled):** [precise scheduling](docs/plan/later-precise-scheduling.md) (any time of day, admin-set roundup time), more networks (TikTok, X, LinkedIn), post analytics, team roles inside a tenant, AI-assisted captions and images.

## Answered questions

| Question | Answer (2026-11-24) | Affects |
| --- | --- | --- |
| Do club posts to the dedicated Page need super admin approval? | No. Free clubs post straight to the dedicated Page; paid clubs can also post to their own Page | Phases 4, 5 |
| Is the dedicated Page Facebook only, or Instagram too? | Facebook only at first | Phases 2 to 4 |
| Leaderboard post: owner's photos, or a generated leaderboard image? | Text + owner's photos now. A generated image card (template rendering, no AI) is a later option | Phase 4 |
| How does the daily roundup run? | Once a day at 2:00 PM Philippine time on a free Vercel Hobby cron. Admin-set time comes later with Vercel Pro | Phase 3 |
| How do scheduled posts run? | Once a day too, in the same 2:00 PM run. "Post now" is immediate. Precise times are deferred to [Later: Precise scheduling](docs/plan/later-precise-scheduling.md) | Phases 2, 4 |

## Open questions

| Question | Working default | Affects |
| --- | --- | --- |
| Who bills the paid tier, and with what provider? | The social app bills; provider decided in Phase 5 (e.g. PayMongo) | Phase 5 |

**Budget rule:** everything runs on free tiers for now (Vercel Hobby, Neon free, free object storage tier). Paid upgrades are noted where they'd help.
