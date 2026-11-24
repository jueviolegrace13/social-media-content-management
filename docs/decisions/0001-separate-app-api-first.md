# ADR-0001: Separate app, API first

**Status:** Accepted (2026-11-24)

## Context

The platform serves the Open Play app first, then Open Play clubs, then outside businesses. Open Play's domain
(open plays, sign-ups, payments, leaderboards) has nothing to do with publishing, and future clients (gyms, event
organizers) won't use Open Play at all.

## Decision

Build the social media platform as its own deployment with its own database. Everything it does is exposed through a
versioned, authenticated API (`/v1/...`). Open Play is an API client like any future one. The platform's own UI uses
the same API.

## Consequences

- Clean separation: Open Play changes can't break publishing, and the platform can serve non-Open Play businesses.
- Each app keeps its own users and super admins; Open Play users don't need a separate login for Open Play features,
  because Open Play calls the API server to server for them.
- Cost: two deployments, two databases, and an integration contract to keep stable (versioned API, webhooks).
