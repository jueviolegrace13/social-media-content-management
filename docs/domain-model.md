# Domain model and first schema draft

Phase 0 draft, 2026-11-24. Drizzle/Postgres. Every table except `admin_users`, `api_clients` and `audit_log` carries `tenant_id`,
and every query on those tables goes through a tenant-scoped helper. IDs are UUIDs; times are `timestamptz` in UTC.

## Entities

```
Tenant ─┬─ SocialAccount (Facebook Page, later Instagram)
        ├─ MediaAsset
        └─ Post ─┬─ PostMedia (ordered images)
                 └─ PostTarget (one per destination) ─┬─ PublishJob
                                                      └─ PublishAttempt (history)
ApiClient ── ApiClientTenant (which tenants it may act for)
          └─ WebhookDelivery
AdminUser    AuditLog    IdempotencyKey    RequestNonce
```

- **Tenant:** a business whose data is isolated. At launch, one tenant: "Open Play platform", owning the dedicated Page.
- **SocialAccount:** one connected destination (a Facebook Page). Holds the encrypted token and health.
- **Post:** what to publish: caption, media, schedule, where it came from. Network-agnostic.
- **PostTarget:** the post on one destination, with its own status and Meta post ID. This is what users see as "published / failed".
- **PublishJob:** the work queue row for a target (due, running, done). Separate from the target so queue mechanics don't leak into history.
- **PublishAttempt:** one call to Meta and its result. Kept for 90 days.

## Tables

### tenants
| column | type | notes |
| --- | --- | --- |
| id | uuid pk | |
| name | text | |
| kind | enum `platform`, `club`, `business` | `platform` = Open Play's own tenant |
| external_ref | text null | e.g. Open Play club ID for club tenants (Phase 5) |
| status | enum `active`, `suspended` | |
| created_at | timestamptz | |

### social_accounts
| column | type | notes |
| --- | --- | --- |
| id, tenant_id | uuid | |
| network | enum `facebook_page` (later `instagram_business`) | |
| external_id | text | Meta Page ID; unique with `network` + `tenant_id` |
| name, picture_url | text | from Meta, refreshed on health check |
| token_ciphertext, token_iv, token_tag | bytea | ADR-0008 |
| token_key_version | smallint | |
| status | enum `connected`, `reconnect_needed`, `disconnected` | |
| last_checked_at, last_error | timestamptz, text | |
| connected_by | text | admin user ID or client app reference |

### media_assets
| column | type | notes |
| --- | --- | --- |
| id, tenant_id | uuid | |
| storage_key | text unique | R2 object key (ADR-0006) |
| public_url | text | |
| content_type | text | after re-encode |
| width, height, size_bytes | integer | |
| sha256 | text | dedupe within a tenant |
| attached_at | timestamptz null | null = unused; deleted after 7 days |
| created_by_client_id | uuid null | |

### posts
| column | type | notes |
| --- | --- | --- |
| id, tenant_id | uuid | |
| caption | text | |
| status | enum `draft`, `scheduled`, `publishing`, `published`, `partially_published`, `failed`, `cancelled` | rolled up from targets |
| scheduled_for | timestamptz null | null = post now |
| source | text | e.g. `open_play.roundup`, `open_play.club_post`, `web` |
| source_ref | text null | e.g. Open Play club ID or draft ID |
| created_by_client_id | uuid null | |
| created_at, updated_at | timestamptz | |

### post_media
`post_id`, `media_asset_id`, `position` (0 to 9). Primary key (`post_id`, `position`).

### post_targets
| column | type | notes |
| --- | --- | --- |
| id, tenant_id, post_id, social_account_id | uuid | unique (`post_id`, `social_account_id`) |
| status | enum `pending`, `publishing`, `published`, `failed`, `cancelled` | |
| external_post_id | text null | Meta post ID |
| permalink | text null | |
| published_at | timestamptz null | |
| error_code, error_message | text null | last permanent error, readable |
| dedupe_marker | text | used to detect unknown-outcome publishes (ADR-0010) |

### publish_jobs
| column | type | notes |
| --- | --- | --- |
| id, tenant_id, post_target_id | uuid | unique `post_target_id` |
| status | enum `due`, `running`, `done`, `dead` | |
| run_at | timestamptz | indexed with `status` |
| attempts | smallint | |
| locked_until | timestamptz null | ADR-0005 |

### publish_attempts
`id`, `tenant_id`, `post_target_id`, `started_at`, `finished_at`, `outcome` (`success`, `transient_error`, `permanent_error`, `unknown`),
`http_status`, `meta_error_code`, `meta_error_subcode`, `message` (tokens redacted).

### api_clients and api_client_tenants
`api_clients`: `id`, `name`, `secret_ciphertext/iv/tag/key_version`, `webhook_url`, `webhook_secret_*`, `scopes` (text[]), `status`, `created_at`, `last_used_at`.
`api_client_tenants`: (`client_id`, `tenant_id`) primary key.

### webhook_deliveries
`id` (= `event_id`), `client_id`, `tenant_id`, `type` (`post.published`, `post.failed`, ...), `payload` jsonb, `status`, `attempts`, `next_attempt_at`, `last_response_status`.

### idempotency_keys
(`client_id`, `key`) primary key, `request_hash`, `response_status`, `response_body` jsonb, `created_at` (expire after 7 days).

### request_nonces
(`client_id`, `nonce`) primary key, `created_at` (purge after 10 minutes).

### admin_users and audit_log
`admin_users`: `id`, `email`, `password_hash` (scrypt), `totp_secret_*` (encrypted), `created_at`, `last_sign_in_at`.
`audit_log`: `id`, `actor_type` (`admin`, `client`, `system`), `actor_id`, `tenant_id` null, `action`, `target_type`, `target_id`, `details` jsonb, `ip`, `created_at`.

## Later phases (not in the first migration)

- Phase 5: `plans`, `subscriptions`, `tenant_users` (club owners signing in through the connect flow), `oauth_states`.
- Phase 6: `users` and `tenant_members` for direct sign-up, `media_folders`, caption templates for the web app.

## Status rules

- A post is `published` when all targets are published, `partially_published` when some are, `failed` when all failed.
- Cancel is allowed while every target is `pending`.
- Deleting a tenant is a soft delete (`suspended`) first; hard delete removes tokens immediately and the rest after 30 days.
