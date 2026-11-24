import { generateKey } from '../server/lib/encryption.js'

/** Prints a new 32-byte encryption key. Prefix it with the next version, e.g. `v2:<key>`, in ENCRYPTION_KEYS. */
console.log(generateKey())
