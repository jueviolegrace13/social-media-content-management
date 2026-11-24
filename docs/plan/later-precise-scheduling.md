# Later: Precise scheduling

**Status:** Not started (deferred, 2026-11-24)

## Goal

Let posts publish at any time of day the user picks (and let the Open Play super admin set the roundup time), instead of the once-a-day run.

## Why it's deferred

We're on free tiers. Vercel Hobby crons run at most once a day and may fire anywhere within the scheduled hour.
Until this is done, the publishing engine runs once a day (2:00 PM PH, 06:00 UTC):
- "Post now" publishes immediately, so it doesn't need the cron.
- A scheduled post publishes in the first daily run at or after its chosen time. The composer should say so.
- Media retention (FR-3.5) deletes post images in the first daily run at least 4 hours after the post finishes, so up
  to about a day. A frequent trigger brings that close to 4 hours.

## Options to decide between

| Option | Cost | Notes |
| --- | --- | --- |
| Vercel Pro per-minute cron | Paid (Vercel Pro) | Simplest; same code path as today |
| External free trigger (cron-job.org, GitHub Actions schedule) | Free | Calls a protected endpoint every few minutes; GitHub schedules can be delayed |
| Hosted queue with delayed delivery (Upstash QStash, Inngest) | Free tier, then paid | Exact-time delivery per post; adds a vendor |

## Tasks

- [ ] Choose an option and record an ADR
- [ ] Endpoint that drains due jobs, protected by a secret, safe to call often and concurrently (no double publish)
- [ ] Composer: allow any time of day; remove the "publishes at the next daily run" note
- [ ] Open Play: admin-set roundup time (Asia/Manila), replacing the fixed 2:00 PM
- [ ] Monitoring: alert if due posts are waiting longer than expected

## Acceptance criteria

- A post scheduled for any time publishes within a few minutes of that time.
- The Open Play super admin can change the roundup time and it applies the next day.

## Depends on

Phase 2 (publishing engine) and Phase 3 (roundup).

## Change log

- 2026-11-24: Created and deferred. Once-a-day publishing is fine for now.
