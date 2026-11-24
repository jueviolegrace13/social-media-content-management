import '../server/lib/loadEnv.js'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { audit } from '../server/services/audit.js'
import { createAdmin } from '../server/services/admins.js'
import { otpauthUri } from '../server/lib/totp.js'

/**
 * Creates a platform super admin (ADR-0009). There is no sign-up screen; this is the only way in.
 *
 *   npm run admin:create -- you@example.com
 *
 * Asks for the password (it shows as you type, so run this in a private terminal), then prints the TOTP secret
 * once to add to an authenticator app.
 */
async function main() {
  const email = process.argv[2]
  if (!email) throw new Error('Usage: npm run admin:create -- <email>')
  const rl = createInterface({ input: stdin, output: stdout })
  const password = await rl.question('Password (at least 14 characters): ')
  const again = await rl.question('Repeat password: ')
  rl.close()
  if (password !== again) throw new Error('Passwords do not match')

  const { admin, totpSecret } = await createAdmin(email, password)
  await audit({ actorType: 'system', action: 'admin.created', targetType: 'admin_user', targetId: admin.id, details: { email: admin.email, via: 'cli' } })

  console.log(`\nAdmin ${admin.email} created.`)
  console.log('Add this to your authenticator app now. It is shown only once:\n')
  console.log(`  Secret: ${totpSecret}`)
  console.log(`  URI:    ${otpauthUri(totpSecret, admin.email)}\n`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
