import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../server/db/client'
import { apiClients } from '../server/db/schema'
import { generateKey } from '../server/lib/encryption'
import { timeStep, totpAt } from '../server/lib/totp'
import { createAdmin, verifyAdminCredentials } from '../server/services/admins'
import { createApiClient } from '../server/services/apiClients'
import { reencryptAll } from '../server/services/reencrypt'
import { ADMIN_PASSWORD, signedRequest, useTestDb } from './helpers'

let db: Db
let close: () => Promise<void>
const original = process.env.ENCRYPTION_KEYS

beforeEach(async () => {
  ;({ db, close } = await useTestDb())
})

afterEach(async () => {
  process.env.ENCRYPTION_KEYS = original
  await close()
})

describe('key rotation', () => {
  it('re-encrypts every secret onto the new key; the old key can then be dropped', async () => {
    const v1 = generateKey()
    const v2 = generateKey()
    process.env.ENCRYPTION_KEYS = `v1:${v1}`
    const created = await createApiClient({ name: 'open-play', scopes: [], tenantIds: [] })
    const { totpSecret } = await createAdmin('root@example.com', ADMIN_PASSWORD)

    process.env.ENCRYPTION_KEYS = `v2:${v2},v1:${v1}`
    expect(await reencryptAll()).toEqual({ apiClients: 1, adminUsers: 1 })
    expect(await reencryptAll()).toEqual({ apiClients: 0, adminUsers: 0 })
    expect((await db.select().from(apiClients))[0]!.secretKeyVersion).toBe(2)

    process.env.ENCRYPTION_KEYS = `v2:${v2}`
    expect((await signedRequest({ id: created.client.id, secret: created.secret }, 'GET', '/v1/whoami')).status).toBe(200)
    expect(await verifyAdminCredentials('root@example.com', ADMIN_PASSWORD, totpAt(totpSecret, timeStep()))).not.toBeNull()
  })
})
