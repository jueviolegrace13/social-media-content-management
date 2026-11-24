import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { and, eq, gt, lt, sql } from 'drizzle-orm'
import { getDb } from '../db/client.js'
import { adminSessions, adminUsers } from '../db/schema.js'
import { badRequest, conflict } from '../errors.js'
import { aadFor, decrypt, encrypt } from '../lib/encryption.js'
import { dummyHash, hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from '../lib/password.js'
import { generateTotpSecret, verifyTotp } from '../lib/totp.js'

/** Platform super admins (ADR-0009): password + TOTP, created only by `npm run admin:create`. */

export const SESSION_HOURS = 12

const totpAad = (adminId: string) => aadFor(null, 'admin_users.totp', adminId)
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

export interface AdminView {
  id: string
  email: string
}

export async function createAdmin(email: string, password: string): Promise<{ admin: AdminView; totpSecret: string }> {
  const normalized = email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+$/.test(normalized)) throw badRequest('Enter a valid email')
  if (password.length < MIN_PASSWORD_LENGTH) throw badRequest(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  const db = getDb()
  const [existing] = await db.select({ id: adminUsers.id }).from(adminUsers).where(eq(adminUsers.email, normalized))
  if (existing) throw conflict('An admin with that email already exists')
  const id = randomUUID()
  const totpSecret = generateTotpSecret()
  const totp = encrypt(totpSecret, totpAad(id))
  await db.insert(adminUsers).values({
    id,
    email: normalized,
    passwordHash: await hashPassword(password),
    totpKeyVersion: totp.keyVersion,
    totpIv: totp.iv,
    totpCiphertext: totp.ciphertext,
    totpTag: totp.tag,
  })
  return { admin: { id, email: normalized }, totpSecret }
}

/**
 * Checks email, password and TOTP code together; returns the admin or null, never saying which part failed.
 * An unknown email still costs a full scrypt, so timing doesn't reveal which emails exist.
 */
export async function verifyAdminCredentials(email: string, password: string, code: string, now: Date = new Date()): Promise<AdminView | null> {
  const db = getDb()
  const [row] = await db.select().from(adminUsers).where(eq(adminUsers.email, email.trim().toLowerCase()))
  const passwordOk = await verifyPassword(password, row?.passwordHash ?? (await dummyHash()))
  if (!row || !passwordOk) return null
  const secret = decrypt({ keyVersion: row.totpKeyVersion, iv: row.totpIv, ciphertext: row.totpCiphertext, tag: row.totpTag }, totpAad(row.id))
  const step = verifyTotp(secret, code, row.totpLastStep, now)
  if (step === null) return null
  // Claim the step atomically: a second sign-in racing with the same code finds the step already used.
  const claimed = await db
    .update(adminUsers)
    .set({ totpLastStep: step, lastSignInAt: now })
    .where(and(eq(adminUsers.id, row.id), sql`(${adminUsers.totpLastStep} IS NULL OR ${adminUsers.totpLastStep} < ${step})`))
    .returning({ id: adminUsers.id })
  if (claimed.length === 0) return null
  return { id: row.id, email: row.email }
}

export async function createAdminSession(adminId: string, now: Date = new Date()): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await getDb()
    .insert(adminSessions)
    .values({ tokenHash: hashToken(token), adminId, expiresAt: new Date(now.getTime() + SESSION_HOURS * 3600_000) })
  return token
}

export async function adminForSession(token: string, now: Date = new Date()): Promise<AdminView | null> {
  const [row] = await getDb()
    .select({ id: adminUsers.id, email: adminUsers.email })
    .from(adminSessions)
    .innerJoin(adminUsers, eq(adminUsers.id, adminSessions.adminId))
    .where(and(eq(adminSessions.tokenHash, hashToken(token)), gt(adminSessions.expiresAt, now)))
  return row ?? null
}

export async function deleteAdminSession(token: string): Promise<void> {
  await getDb().delete(adminSessions).where(eq(adminSessions.tokenHash, hashToken(token)))
}

export async function purgeExpiredAdminSessions(now: Date = new Date()): Promise<number> {
  const deleted = await getDb().delete(adminSessions).where(lt(adminSessions.expiresAt, now)).returning({ t: adminSessions.tokenHash })
  return deleted.length
}
