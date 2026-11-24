# ADR-0002: Native composer in client apps, not an iframe

**Status:** Accepted (2026-11-24)

## Context

Club owners create posts from inside Open Play. Two options: embed the platform's composer in an iframe, or build the
posting screens in Open Play and call the platform's API.

## Decision

Build posting screens natively in Open Play. Open Play's server calls the platform's API with its client credentials.
The only time a user leaves Open Play is to connect their own Facebook Page (paid tier): a redirect to the platform's
hosted connect page and back.

## Why not an iframe

- A cross-site iframe can't reliably keep a session: Safari blocks third-party cookies and Chrome restricts them.
- Facebook Login refuses to load inside an iframe, so the connect flow would need a redirect anyway.
- Framing needs `frame-ancestors` rules and clickjacking care, and feels clunky on phones.
- A native screen matches Open Play's look and can prefill from Open Play data directly.

## Consequences

- Open Play carries some UI work (composer, preview, status).
- The platform's standalone app (Phase 6) has its own composer; shared pieces can become a package later if worthwhile.
