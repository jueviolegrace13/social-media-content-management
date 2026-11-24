# Phase 3: Daily "Today's Open Plays"

**Status:** Not started

## Goal

Every day at 2:00 PM Philippine time, Open Play gathers that day's listed open plays and posts a roundup to the dedicated Page.

## Scope

**In:** Open Play super admin role and settings, roundup template, daily job, delivery through the social API, status shown in Open Play.
**Out:** admin-set post time (needs Vercel Pro, later), images generated from the roundup (later), Instagram.

## Tasks

### Open Play super admin (open-play)
- [ ] Platform admin role separate from club roles (owner/organizer/member), with a protected admin area
- [ ] Settings: on/off switch, roundup template, "skip when no open plays" option (post time fixed at 2:00 PM for now)

### Roundup (open-play)
- [ ] Gather the day's open plays that are listed publicly (`/open-plays` rules), ordered by start time
- [ ] Template with placeholders (date, club, venue, time, slots left, event link); length check against Facebook limits
- [ ] Tag or name each club (club Facebook Page from club settings, per Phase 0 finding on tagging)
- [ ] Preview in the admin area, plus "Post now" for testing

### Scheduling and delivery (open-play, social)
- [ ] Vercel Hobby cron at `0 6 * * *` (06:00 UTC = 2:00 PM PH); Hobby may fire anywhere in that hour. One roundup per date, even if the job runs twice
- [ ] Call `POST /v1/posts` with an idempotency key based on the date
- [ ] Receive status webhooks; show the day's post status and link in the admin area

### Club settings (open-play)
- [ ] Club Facebook Page link field in club settings, validated

## Acceptance criteria

- With posting on, a roundup appears on the dedicated Page once a day in the 2:00 PM hour (PH time).
- Turning it off stops posts.
- A failure shows in Open Play's admin area with the reason.

## Depends on

Phase 2.

## Change log

- 2026-11-24: Phase created.
- 2026-11-24: Fixed daily time of 2:00 PM PH on a free Vercel Hobby cron. Admin-set time moved to later (Vercel Pro).
