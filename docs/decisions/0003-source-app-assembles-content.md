# ADR-0003: The source app assembles content; this app publishes

**Status:** Accepted (2026-11-24)

## Context

Posts like "Today's Open Plays" and club leaderboards are built from Open Play data. Either the platform reads Open
Play's data and builds posts, or Open Play builds the post and hands it over.

## Decision

The source app (Open Play) owns its data, templates and the logic that turns activity into a caption and media list.
It sends a ready post to the platform. The platform owns accounts, tokens, media storage, scheduling, publishing,
retries and history, and reports status back by signed webhook.

## Consequences

- The platform has no Open Play domain logic and no access to Open Play's database.
- Every future client (gyms, events) integrates the same way.
- Templates for Open Play posts live in Open Play. Generic caption templates for the standalone app live in the platform.
