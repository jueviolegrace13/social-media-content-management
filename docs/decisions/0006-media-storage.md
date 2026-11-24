# ADR-0006: Media storage

**Status:** Proposed (2026-11-24). Confirm free tier limits before Phase 2.

## Context

Meta fetches post images by URL (and Instagram requires a public URL). Open Play stores images as base64 in Postgres, which
is fine for receipts but won't scale for post media and can't give Meta a direct URL cheaply.

## Decision

Store media in **Cloudflare R2** through its S3-compatible API.
- Free tier includes storage and **no egress fees**, which matters because every view and every Meta fetch is egress.
- Objects use random, unguessable keys under a tenant prefix (`t/<tenant>/<uuid>.jpg`), served from a public bucket domain.
- Uploads go through our API (validate, re-encode, then put), so nothing unvalidated reaches the bucket.

## Alternatives

- **Vercel Blob:** simplest on Vercel, but Hobby limits and egress pricing are tighter. Fine fallback.
- **Postgres (like Open Play):** no public URL for Meta without proxying every fetch through a function; bloats the database.

## Trade-offs

- One more account (Cloudflare) and two secrets to manage.
- Public URLs are unguessable but not private. Post media is meant to be public anyway; nothing sensitive goes in this bucket.
