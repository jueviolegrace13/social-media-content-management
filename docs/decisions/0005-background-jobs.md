# ADR-0005: Background jobs on free hosting

**Status:** Accepted (2026-11-24)

## Context

Vercel Functions are short-lived and Vercel Hobby crons run at most once a day, firing anywhere within the scheduled hour.
We're staying on free tiers. Publishing needs to be reliable and never double post.

## Decision

- Jobs live in a Postgres table (`publish_jobs`), one row per post destination.
- **Post now:** the API request creates the job and processes it right after responding (Vercel `waitUntil`), so it doesn't wait for the cron.
- **Scheduled and retries:** one Vercel Hobby cron at `0 6 * * *` (2:00 PM PH) calls a protected `/internal/run-jobs` endpoint
  that processes every job that's due, in a loop, until its time budget is nearly used.
- **Claiming** is one atomic statement, so overlapping runs can't take the same job:
  `UPDATE publish_jobs SET status='running', locked_until=now()+interval '5 min' WHERE id IN (SELECT id FROM publish_jobs WHERE status='due' AND run_at<=now() ORDER BY run_at LIMIT 10 FOR UPDATE SKIP LOCKED) RETURNING *`.
  A single statement works over Neon's HTTP driver; no session transaction needed.
- Jobs stuck in `running` past `locked_until` go back to `due` on the next run.
- The endpoint takes the same secret check Open Play's cron routes use.

## Trade-offs

- Retries of scheduled posts wait until the next daily run (up to a day). Acceptable for now; "post now" retries happen within the same request a few times first.
- If one run can't finish everything, the rest waits a day. Volume is low at launch; the run logs a warning when it stops with jobs left.
- Upgrading is a trigger change only: a more frequent caller (Vercel Pro cron or external scheduler) hits the same endpoint.
  See [Later: Precise scheduling](../plan/later-precise-scheduling.md).
