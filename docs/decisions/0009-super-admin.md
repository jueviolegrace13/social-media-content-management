# ADR-0009: Super admins in both apps

**Status:** Accepted (2026-11-24)

## Context

Both apps need a super admin. Open Play today only has club roles (owner, organizer, member).

## Decision

**Platform:** separate `admin_users` table, not shared with any end user accounts.
- Password (scrypt, Node built-in) + TOTP required. Created only by a CLI script; no sign-up screen.
- Its own session cookie and admin area at `/admin`.

**Open Play:** a `platform_admins` table that points at existing Open Play users.
- Granted only by a CLI script or by another platform admin.
- TOTP required to enter the admin area, even though normal Open Play sign-in doesn't use it.
- Admin routes check the table on every request; club roles never grant platform admin rights.

**Not shared sign-in for now.** The two admin areas manage different things, and one person can hold both accounts.
Single sign-on can come later if the admin team grows.

## Trade-offs

Two admin logins to keep. In exchange, a compromised Open Play user account can't reach the platform's tokens, and neither app
depends on the other being up to sign in.
