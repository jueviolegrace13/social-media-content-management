# ADR-0010: Idempotency and retries

**Status:** Accepted (2026-11-24)

## Decision

**Creating posts**
- Clients send `Idempotency-Key` on `POST /v1/posts` (and media upload). The key is unique per client for 7 days.
- Same key and same body: return the original response. Same key, different body: `409 Conflict`.
- Open Play uses meaningful keys, e.g. `roundup:2026-11-25` or `club-post:<draft-id>`.

**Publishing**
- One `publish_jobs` row per destination; a unique constraint on (post, destination) prevents duplicates.
- Each attempt is a row in `publish_attempts`.
- Error classes:
  - *Transient:* network errors, Meta 5xx, rate limits (codes 4, 17, 32, 613, 80001). Retry with backoff: 1 min, 5 min, then next daily run, up to 5 attempts.
  - *Permanent:* invalid or expired token (190), missing permission (10, 200), content rejected (100 with policy subcodes). Fail now; mark account "reconnect needed" for 190.
  - *Unknown outcome:* timeout after the request was sent. Before retrying, read the Page's recent posts and match on a marker we keep
    per job (caption hash + time window). If found, record it as published.

**Webhooks**
- At-least-once delivery with an `event_id`; retried with backoff for up to 24 hours. Receivers must deduplicate.
