# ADR-0007: Authentication between client apps and the platform

**Status:** Accepted (2026-11-24)

## Context

Open Play's server calls the platform's API, and the platform calls Open Play back with status webhooks. Both directions must
prove who's calling and resist replays. No end user tokens are involved.

## Decision

**Client to platform:** API key ID + secret, with HMAC-SHA256 request signing.
- Headers: `X-Client-Id`, `X-Timestamp`, `X-Nonce`, `X-Signature`.
- Signature over `method + path + timestamp + nonce + sha256(body)` using the client secret.
- Requests older than 5 minutes are refused; nonces are remembered for 10 minutes to refuse replays.
- The platform stores the secret encrypted (it needs it to verify HMACs), never hashed-only, and shows it once on creation.
- Each client is scoped to the tenants it may act for and to allowed actions.

**Platform to client (webhooks):** same signing scheme with a separate per-client webhook secret. Each event has an `event_id`
for deduplication.

## Why not a bearer API key alone

A leaked bearer key works until rotated. A signed request can't be replayed or altered in transit, and the secret never travels.

## Why not OAuth client credentials

It adds a token endpoint and token caching for a two-app system we control. HMAC signing gives the same guarantees with less code.
Revisit if third-party developers get API access.
