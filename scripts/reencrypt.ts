import '../server/lib/loadEnv.js'
import { audit } from '../server/services/audit.js'
import { reencryptAll } from '../server/services/reencrypt.js'

/** Key rotation: re-encrypts every secret still on an older key (ADR-0008). */
reencryptAll()
  .then(async (counts) => {
    await audit({ actorType: 'system', action: 'secrets.reencrypted', details: counts })
    console.log(`Re-encrypted ${counts.apiClients} API client secrets and ${counts.adminUsers} admin TOTP secrets.`)
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
