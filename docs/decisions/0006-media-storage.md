# ADR-0006: Media storage

**Status:** Accepted (2026-11-25). Vercel Blob, replacing the earlier Cloudflare R2 proposal.

## Context

Meta fetches post images by URL (and Instagram requires a public URL). Open Play stores images as base64 in Postgres, which
is fine for receipts but won't scale for post media and can't give Meta a direct URL cheaply.

## Decision

Store media in **Vercel Blob** with public access.
- One platform: the app, crons and media all live in the Vercel project. Connecting a Blob store adds
  `BLOB_READ_WRITE_TOKEN` automatically, so there are no storage secrets to copy by hand.
- Objects use unguessable keys under a tenant prefix (`t/<tenant>/<uuid>.jpg`), stored as the blob pathname with no
  extra random suffix (the UUID already is one), so deleting needs only the key.
- Uploads go through our API (validate, re-encode, then put), so nothing unvalidated reaches the store.
- Blob supports direct client uploads, which is the way around Vercel's 4.5 MB function request body limit if large
  photos become a problem.
- Free tier media is short-lived anyway: post images are deleted about 4 hours after the post finishes (FR-3.5), which
  keeps storage small.

## Alternatives

- **Cloudflare R2:** free egress and a generous free tier, but one more account and five secrets. The first proposal.
  Swapping back is one class behind the `MediaStorage` interface (`server/lib/storage.ts`).
- **Postgres (like Open Play):** no public URL for Meta without proxying every fetch through a function; bloats the database.

## Trade-offs

- Data transfer is billed (R2's egress is free). Every Meta fetch and every view counts. Small for a few clubs; revisit if
  media traffic grows.
- Vercel Hobby is for non-commercial use and has tight Blob limits. Paid clubs mean Vercel Pro anyway.
- Public URLs are unguessable but not private. Post media is meant to be public; nothing sensitive goes in this store.
