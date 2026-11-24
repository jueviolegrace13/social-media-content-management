# Open Play integration contract

Phase 0 draft, 2026-11-24. How the Open Play app uses the platform. Principles from ADR-0001 to ADR-0003:
Open Play builds the content; the platform publishes it. Calls are server to server and signed (ADR-0007).

## Setup (once)

1. Platform super admin creates tenant "Open Play platform" and connects the dedicated Page to it.
2. Super admin creates an API client "open-play" scoped to that tenant, with Open Play's webhook URL.
3. Open Play stores in its environment: `SOCIAL_API_URL`, `SOCIAL_CLIENT_ID`, `SOCIAL_CLIENT_SECRET`, `SOCIAL_WEBHOOK_SECRET`,
   `SOCIAL_DEDICATED_ACCOUNT_ID`.

## Endpoints Open Play calls

All under `/v1`, signed, JSON unless uploading.

| Call | Purpose | Notes |
| --- | --- | --- |
| `GET /v1/accounts` | List destinations Open Play may post to | Used to show the dedicated Page name/picture in previews |
| `POST /v1/media` | Upload one image (raw bytes, `Content-Type: image/*`) | Returns `{ id, url, width, height }`. Needs `Idempotency-Key` |
| `POST /v1/posts` | Create a post | Body below. Needs `Idempotency-Key` |
| `GET /v1/posts?source_ref=...&status=...` | List posts | For club post history in Open Play |
| `GET /v1/posts/:id` | One post with per-destination status | |
| `POST /v1/posts/:id/cancel` | Cancel before publishing starts | |
| `DELETE /v1/posts/:id/targets/:targetId` | Take a published post down from a destination | Super admin takedown (FR-9.5) |

### Create post body

```json
{
  "caption": "Today's Open Plays, Wed Nov 25 ...",
  "media_ids": ["<uuid>"],
  "account_ids": ["<dedicated page account id>"],
  "scheduled_for": null,
  "source": "open_play.roundup",
  "source_ref": "2026-11-25"
}
```

- `scheduled_for: null` publishes now. A date publishes in the daily 2:00 PM PH run on or after it.
- Response `201` with the post, its targets and statuses. Replays with the same `Idempotency-Key` return the same post.

### Idempotency keys Open Play uses

| Flow | Key |
| --- | --- |
| Daily roundup | `roundup:<YYYY-MM-DD>` |
| Club post | `club-post:<open play draft id>` |
| Media upload | `media:<open play draft id>:<file position>` |

## Webhooks Open Play receives

`POST <open play>/api/integrations/social/webhook`, signed with the webhook secret.

```json
{
  "event_id": "<uuid>",
  "type": "post.published",
  "occurred_at": "2026-11-25T06:01:12Z",
  "post": { "id": "...", "status": "published", "source": "open_play.club_post", "source_ref": "<draft id>",
            "targets": [{ "account_id": "...", "status": "published", "permalink": "https://facebook.com/..." }] }
}
```

Types: `post.published`, `post.partially_published`, `post.failed`, `post.cancelled`, `post.taken_down`.
Open Play must answer `2xx` quickly and deduplicate by `event_id`.

## What Open Play owns (Open Play repo)

- `platform_admins` table and admin area with TOTP (ADR-0009).
- Settings: roundup on/off, roundup template, "skip when no open plays", per club post limit.
- `club_social_links` (or a column on `clubs`): the club's Facebook Page URL.
- `social_posts` table mirroring what it sent: local draft ID, club ID, platform post ID, last known status, permalink.
- Templates and caption building for the roundup and club posts.
- Daily cron at `0 6 * * *` (Open Play's `vercel.json`) that builds and sends the roundup. Check the Hobby cron count limit first;
  Open Play already uses 2 crons.
- Player consent: a profile setting "Show my name in club social posts". Only these players appear in prefilled captions.

## Data the roundup uses (from Open Play's `open_plays` table)

`title`, `date`, `start_time`, `end_time`, `venue`, `max_players` (minus confirmed sign-ups for slots left), `listed = true`,
`status = planned`, `archived_at is null`, `share_token` (event link `/e/<token>`), and the club's name and Facebook Page link.

## Club Page tags

Until Page Mentioning is approved (see [meta-graph-api.md](meta-graph-api.md)), captions include the club's name and Page link.
When approved, Open Play adds `@[<page id>]` for clubs with a Page ID on file. That needs the club's numeric Page ID, which Open Play
can resolve from the link once; store it alongside the link.

## Failure handling in Open Play

- Platform unreachable when sending: retry the call with the same idempotency key (safe), up to 3 times, then show "couldn't send" with a retry button.
- `post.failed` webhook: show the reason to the super admin (roundup) or the club owner (club post).
- Missed webhook: Open Play's daily cron also reconciles any `social_posts` not in a final state by calling `GET /v1/posts/:id`.
