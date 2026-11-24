# Phase 4: Club leaderboard posts

**Status:** Not started

## Goal

Club owners create posts about their leaderboard, top players and extra details inside Open Play, and those posts go to the dedicated Page with the club tagged.

## Scope

**In:** composer screen in Open Play (native, not an iframe), leaderboard data prefill, photo upload, preview, scheduling, status.
**Out:** super admin approval (not needed), posting to the club's own Page (Phase 5), generated leaderboard image cards (later; template rendering, no AI).

## Tasks

### Composer (open-play)
- [ ] "Create post" entry on the club leaderboard and on a completed open play
- [ ] Prefill from Open Play data: club, period, top players, podium, session stats
- [ ] Caption templates the owner can pick and edit; club Page tag added automatically
- [ ] Photo upload (sent to the social app's media API), reorder, remove
- [ ] Facebook-style preview
- [ ] Post now or schedule for a date (publishes in that day's 2:00 PM run for now); save draft

### Status and safeguards (open-play)
- [ ] Owner sees scheduled, published and failed posts, with the post link
- [ ] Per club limit (for example, posts per week) set by super admin, to keep the dedicated Page from being flooded
- [ ] Super admin can take down a published post from the dedicated Page if needed

### Social side (social)
- [ ] Attribute posts to the club (source tenant/club ID) for history and limits
- [ ] Player consent: only include players who allow being named publicly (check Open Play profile settings)

## Acceptance criteria

- An owner can go from leaderboard to a published post on the dedicated Page without retyping data.
- Posts publish without approval and respect the per club limit.
- Owners see the status of every post they made.

## Depends on

Phases 2 and 3 (super admin area, club Page field).

## Change log

- 2026-11-24: Phase created.
- 2026-11-24: No super admin approval: free clubs post straight to the dedicated Page. Added per club limit and super admin takedown as safeguards. Text + owner photos only.
- 2026-11-24: Scheduling is by date in the daily run until precise scheduling lands.
