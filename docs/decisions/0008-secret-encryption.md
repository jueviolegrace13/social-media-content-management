# ADR-0008: Encrypting tokens and secrets

**Status:** Accepted (2026-11-24)

## Decision

- AES-256-GCM using Node's built-in `crypto`. No extra dependency.
- Keys come from an environment variable key ring, e.g. `ENCRYPTION_KEYS="v2:<base64>,v1:<base64>"`; the first is used for new writes.
- Each encrypted value stores `key_version`, `iv` (12 random bytes), `ciphertext` and `auth_tag`.
- Additional authenticated data binds the value to its row (`tenant_id:table:row_id`), so a ciphertext copied to another row fails to decrypt.
- Rotation: add a new key first in the ring, run a re-encrypt script, then remove the old key.
- Decrypted tokens exist only in memory during a call and are never logged.

## Trade-offs

A full cloud KMS would add key access logging and hardware protection, but costs money and adds latency. Env-held keys on Vercel
are acceptable for this stage; the key-version column makes a later KMS move a re-encrypt, not a redesign.
