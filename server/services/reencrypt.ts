import { eq } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { adminUsers, apiClients } from '../db/schema.js'
import { aadFor, decrypt, encrypt, needsReencrypt } from '../lib/encryption.js'
import { secretAad, storedSecret } from './apiClients.js'

/**
 * Key rotation step 2 (ADR-0008): re-encrypts every value still on an older key with the current key.
 * Safe to run more than once. Add new encrypted columns here as later phases add them (e.g. Page tokens).
 */
export async function reencryptAll(): Promise<{ apiClients: number; adminUsers: number }> {
  const db = getDb()
  let clients = 0
  for (const row of await db.select().from(apiClients)) {
    if (!needsReencrypt({ keyVersion: row.secretKeyVersion })) continue
    const next = encrypt(decrypt(storedSecret(row), secretAad(row.id)), secretAad(row.id))
    await db
      .update(apiClients)
      .set({ secretKeyVersion: next.keyVersion, secretIv: next.iv, secretCiphertext: next.ciphertext, secretTag: next.tag })
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
  return { apiClients: clients, adminUsers: admins }
}
