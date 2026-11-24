# Meta Graph API findings

Research for Phase 0, checked 2026-11-24. Graph API is at v26.0 (since 2026-07-29, per Breakreach).
Where a claim comes from third-party commentary rather than Meta's own docs, it's marked *(third party)*.
Re-check anything marked **Verify** against the live app before building on it.

## Summary for this project

| Phase | What we need from Meta | Needs App Review? |
| --- | --- | --- |
| 2 to 4: post to our own dedicated Page | `pages_show_list`, `pages_read_engagement`, `pages_manage_posts` on a Page our developer account manages | No. Works in Development mode / Standard Access |
| 3 to 4: tag club Pages in posts | Page Mentioning feature | **Yes, plus business verification.** Without it, `@[page-id]` tags are silently stripped |
| 5: post to clubs' own Pages | `pages_manage_posts` etc. with Advanced Access, Facebook Login for Business | Yes, plus business verification |
| 6: Instagram | Instagram content publishing permissions | Yes |

**Consequence for phases 3 and 4:** until App Review and business verification for Page Mentioning are done, posts name the club and
include its Facebook Page link in the caption instead of a tag. Tagging is switched on later behind a setting. Include Page Mentioning
in the first App Review submission.

## Permissions and access levels

- **Standard Access** works only against assets that people with a role on the app (admin, developer, tester) manage.
  Posting to our own dedicated Page is covered. *(third party: bundle.social, Breakreach)*
- **Advanced Access** is needed for Pages of people with no role on the app. It requires App Review and business verification.
  Review typically takes about a week to 3 weeks. *(third party)*
- Permissions for Page publishing: `pages_manage_posts` (requires `pages_read_engagement` and `pages_show_list`). *(third party)*
- The Page admin connecting the Page must have a role that includes the "create content" task, or publishing fails
  with error 1 / subcode 2853006. *(third party: Breakreach)*

## Page Mentioning (tagging other Pages)

- Meta: the feature "allows your app mention any Facebook Page when publishing posts on the Pages managed by your app",
  for `/page/feed`. It needs App Review for live data and "is only available with business verification."
  ([Meta: Page Mentioning](https://developers.secure.facebook.com/documentation/development/features-reference/page-mentioning))
- Observed: without the feature, a feed post with `@[page_id]` publishes with the tag removed and no error.
  *(third party: [Postiz issue #1548](https://github.com/gitroomhq/postiz-app/issues/1548), tested 2026-05-21)*
- The mentioned Page may need "Others tagging this Page" enabled. *(Meta comments/mentions doc; stated for comments)*
- **Verify:** behavior once approved, and whether the Page being tagged needs any setting.

## Tokens

- Flow: Facebook Login gives a short-lived user token (about 1 to 2 hours), exchange it for a long-lived user token (about 60 days),
  then `GET /{user-id}/accounts` returns Page tokens. ([Meta: long-lived tokens](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived))
- Meta: "Long-lived Page access tokens do not have an expiration date and only expire or are invalidated under certain conditions."
- Invalidated when the user changes their password, loses their Page role, or removes the app *(third party)*.
  Error 190 (subcode 492 for a lost Page role) means "reconnect needed".
- Page tokens are unique per Page, admin and app.
- **Alternative for our own dedicated Page:** a system user token from our Meta Business account, with a chosen expiry preference.
  It isn't tied to one person's Facebook login or password. **Verify** it fits Standard Access before choosing it.
- **Design rule:** never assume a token lasts forever. Store it encrypted, check health daily, and mark the account "reconnect needed" on error 190.

## Limits

- Page API calls: about 4,800 × the Page's engaged users per 24 hours. Error 32 / 80001 means rate limited, and the
  `X-Business-Use-Case-Usage` header says when calls work again. *(third party: Breakreach)*
- No documented daily cap on Page feed posts; Reels are limited to 30 per 24 hours via API. *(third party)*
- Meta's own scheduling (`scheduled_publish_time`) accepts 10 minutes to 30 days ahead. We schedule on our side instead, so this isn't a constraint.
- Instagram: a daily publishing cap exists (commonly cited as 50 per 24 hours; one source says 100). **Verify** in Phase 6.

## App Review requirements (for phase 5 and tagging)

- A public privacy policy that describes data deletion in plain language, and a working data deletion callback URL. *(third party: bundle.social)*
- A screencast for each requested permission showing the real flow.
- Business verification for Advanced Access and Page Mentioning.
- These need the app to be deployed with a public URL, so the submission happens after Phase 2 is live.

## Our Meta setup

As of 2026-11-24. The App Secret is never stored in this repo; it goes in the deployment's environment variables only.

| Item | Value |
| --- | --- |
| Meta app | "Content Management", App ID `1805184584083738` |
| Use case | "Manage everything on your Page" |
| Mode | Development |
| Permissions (ready for testing) | `pages_show_list`, `pages_read_engagement`, `pages_manage_posts` |
| Dedicated Facebook Page | Page ID `61596641620772` ([facebook.com/profile.php?id=61596641620772](https://www.facebook.com/profile.php?id=61596641620772)) |
| Business portfolio | "404 Open Play" (name for now) |
| Business verification | Deferred to [Phase 5](plan/phase-5-paid-club-pages.md): needs a registered business first |

## Owner steps (rendee)

- [x] Create the Meta app (type: Business) under a Meta Business account
- [x] Create the dedicated Facebook Page and make sure your Facebook account is its admin
- [ ] Register the business and complete business verification in Meta Business settings (deferred to Phase 5)

## Sources

- [Meta: Page Mentioning feature](https://developers.secure.facebook.com/documentation/development/features-reference/page-mentioning)
- [Meta: Comments and @mentions](https://developers.facebook.com/documentation/pages-api/comments-mentions.md)
- [Meta: Long-lived access tokens](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived)
- [Meta: Access tokens](https://developers.facebook.com/documentation/facebook-login/guides/access-tokens.md)
- [bundle.social: Facebook API permissions and App Review](https://bundle.social/blog/facebook-api-permissions) (2026-08-04)
- [Breakreach: Facebook API in 2026](https://www.breakreach.com/developers/facebook-api) (checked 2026-10-06)
- [Postiz issue #1548](https://github.com/gitroomhq/postiz-app/issues/1548)
