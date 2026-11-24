# Architecture decision records

One short file per decision: the context, what we decided, and the trade-offs. Numbered in order; never renumber.
To change a decision, add a new ADR that supersedes the old one and set the old one's status to "Superseded by ADR-XXXX".

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-separate-app-api-first.md) | Separate app, API first | Accepted |
| [0002](0002-native-composer-not-iframe.md) | Native composer in client apps, not an iframe | Accepted |
| [0003](0003-source-app-assembles-content.md) | The source app assembles content; this app publishes | Accepted |
| [0004](0004-tech-stack.md) | Same stack as Open Play | Accepted |
| [0005](0005-background-jobs.md) | Background jobs: Postgres job table + daily cron + post now inline | Accepted |
| [0006](0006-media-storage.md) | Media in Vercel Blob | Accepted |
| [0007](0007-service-auth.md) | HMAC-signed requests between apps | Accepted |
| [0008](0008-secret-encryption.md) | AES-256-GCM with a versioned key ring | Accepted |
| [0009](0009-super-admin.md) | Separate super admins per app, with TOTP | Accepted |
| [0010](0010-idempotency-and-retries.md) | Idempotency keys, error classes and retries | Accepted |
