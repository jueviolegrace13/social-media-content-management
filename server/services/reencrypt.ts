import { eq } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { adminUsers, apiClients, socialAccounts } from '../db/schema.js'
import { aadFor, decrypt, encrypt, needsReencrypt } from '../lib/encryption.js'
import { secretAad, storedSecret, storedWebhookSecret, webhookColumns, webhookSecretAad } from './apiClients.js'
import { storedToken, tokenAad, tokenColumns } from './socialAccounts.js'

/**
 * Key rotation step 2 (ADR-0008): re-encrypts every value still on an older key with the current key.
 * Safe to run more than once. Facebook Login rows (`oauth_states`) are left alone: they expire within 15 minutes,
 * so wait that long after rotating before removing the old key.
 */
export async function reencryptAll(): Promise<{ apiClients: number; adminUsers: number; socialAccounts: number }> {
  const db = getDb()
  let clients = 0
  for (const row of await db.select().from(apiClients)) {
    const webhook = storedWebhookSecret(row)
    const secretOld = needsReencrypt({ keyVersion: row.secretKeyVersion })
    const webhookOld = webhook !== null && needsReencrypt(webhook)
    if (!secretOld && !webhookOld) continue
    const next = encrypt(decrypt(storedSecret(row), secretAad(row.id)), secretAad(row.id))
    const nextWebhook = webhook ? encrypt(decrypt(webhook, webhookSecretAad(row.id)), webhookSecretAad(row.id)) : null
    await db
      .update(apiClients)
      .set({
        secretKeyVersion: next.keyVersion,
        secretIv: next.iv,
        secretCiphertext: next.ciphertext,
        secretTag: next.tag,
        ...webhookColumns(nextWebhook),
      })
      .where(eq(apiClients.id, row.id))
    clients++
  }

  let admins = 0
  for (const row of await db.select().from(adminUsers)) {
    if (!needsReencrypt({ keyVersion: row.totpKeyVersion })) continue
    const aad = aadFor(null, 'admin_users.totp', row.id)
    const plain = decrypt({ keyVersion: row.totpKeyVersion, iv: row.totpIv, ciphertext: row.totpCiphertext, tag: row.totpTag }, aad)
    const next = encrypt(plain, aad)
    await db
      .update(adminUsers)
      .set({ totpKeyVersion: next.keyVersion, totpIv: next.iv, totpCiphertext: next.ciphertext, totpTag: next.tag })
      .where(eq(adminUsers.id, row.id))
    admins++
  }

  let accounts = 0
  for (const row of await db.select().from(socialAccounts)) {
    const stored = storedToken(row)
    if (!stored || !needsReencrypt(stored)) continue
    const aad = tokenAad(row.tenantId, row.id)
    await db
      .update(socialAccounts)
      .set(tokenColumns(encrypt(decrypt(stored, aad), aad)))
      .where(eq(socialAccounts.id, row.id))
    accounts++
  }
  return { apiClients: clients, adminUsers: admins, socialAccounts: accounts }
}
