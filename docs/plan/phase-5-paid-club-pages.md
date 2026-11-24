# Phase 5: Paid tier, clubs' own Pages

**Status:** Not started

## Goal

Paying clubs connect their own Facebook Page and their Open Play posts publish there instead of (or as well as) the dedicated Page.

## Scope

**In:** Meta App Review, a tenant per paying club, Facebook Login connect flow, plans and limits, billing.
**Out:** external businesses without an Open Play club (Phase 6).

## Tasks

### Meta (owner + social)
- [ ] Register the business (e.g. DTI sole proprietorship) and complete Meta business verification
- [ ] App Review submission for `pages_manage_posts` and related permissions (screencast, privacy policy, data deletion endpoint)

### Connect flow (social, open-play)
- [ ] "Connect Facebook Page" in Open Play club settings sends the owner to the social app's hosted connect page and back
- [ ] Social app creates or links the club's tenant, stores the Page token encrypted
- [ ] Disconnect and reconnect; data deletion callback for Meta

### Plans and billing (social)
- [ ] Plans and limits configurable by super admin (accounts, posts per month); Open Play club discount
- [ ] Billing provider integration (choice from Phase 0/5, e.g. PayMongo), subscription status, grace period
- [ ] Destination choice in Open Play composer: dedicated Page, own Page, or both (by plan)

## Acceptance criteria

- A club owner pays, connects their Page and publishes an Open Play post to it.
- A lapsed subscription falls back to dedicated Page only.
- App Review approved.

## Depends on

Phase 4. App Review approval (outside our control on timing).

## Change log

- 2026-11-24: Phase created.
- 2026-11-24: Business registration and Meta business verification moved here from Phase 0 (no registered business yet).
