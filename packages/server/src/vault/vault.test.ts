import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { assets, users } from '../db/schema.ts'
import { createTestDatabase } from '../test/harness.ts'
import { VaultService } from './vault.ts'

const harness = await createTestDatabase()
const db: Database = harness.db
const SECRET = 'a-test-secret-that-is-at-least-32-characters'
const vault = new VaultService(db, { secret: SECRET })

afterAll(() => harness.close())

let userId: string
let otherId: string

beforeEach(async () => {
  await db.execute(sql`truncate assets, users cascade`)
  const rows = await db
    .insert(users)
    .values([
      { email: 'owner@example.com', name: 'Owner' },
      { email: 'other@example.com', name: 'Other' },
    ])
    .returning()
  userId = rows[0]!.id
  otherId = rows[1]!.id
})

let counter = 0
async function addAsset(ownerId = userId) {
  counter++
  const [row] = await db
    .insert(assets)
    .values({
      ownerId,
      type: 'image',
      status: 'ready',
      originalFilename: `photo-${counter}.jpg`,
      mimeType: 'image/jpeg',
      checksum: counter.toString(16).padStart(64, '0'),
      sizeBytes: 100,
      originalPath: `x/${counter}.jpg`,
      capturedAt: new Date(),
    })
    .returning()
  return row!
}

const SESSION = 'session-abc'

describe('setting up the vault', () => {
  test('reports itself unconfigured before first use', async () => {
    expect(await vault.isConfigured(userId)).toBe(false)
  })

  test('is configured once a passphrase is set', async () => {
    await vault.setPassphrase(userId, 'a-strong-vault-passphrase')

    expect(await vault.isConfigured(userId)).toBe(true)
  })

  test('never stores the passphrase itself', async () => {
    await vault.setPassphrase(userId, 'correct-horse-battery-staple')

    const [row] = await db.select().from(users).where(eq(users.id, userId))
    expect(row!.vaultPassphraseHash).not.toContain('correct-horse')
    expect(row!.vaultPassphraseHash).toStartWith('$argon2')
  })

  test('refuses a passphrase that is too short to be worth having', async () => {
    await expect(vault.setPassphrase(userId, 'short')).rejects.toThrow()
  })

  test('each account has its own vault', async () => {
    await vault.setPassphrase(userId, 'a-strong-vault-passphrase')

    expect(await vault.isConfigured(otherId)).toBe(false)
  })
})

describe('unlocking', () => {
  beforeEach(async () => {
    await vault.setPassphrase(userId, 'a-strong-vault-passphrase')
  })

  test('issues a token for the right passphrase', async () => {
    const token = await vault.unlock(userId, 'a-strong-vault-passphrase', SESSION)

    expect(token).toBeString()
    expect(vault.verify(token, userId, SESSION)).toBe(true)
  })

  test('refuses the wrong passphrase', async () => {
    await expect(vault.unlock(userId, 'not-the-passphrase', SESSION)).rejects.toThrow()
  })

  test('refuses to unlock a vault that was never set up', async () => {
    await expect(vault.unlock(otherId, 'anything-at-all', SESSION)).rejects.toThrow()
  })

  test('a token is worthless to a different account', async () => {
    const token = await vault.unlock(userId, 'a-strong-vault-passphrase', SESSION)

    expect(vault.verify(token, otherId, SESSION)).toBe(false)
  })

  /** A cookie lifted from one browser must not open the vault in another. */
  test('a token is bound to the session that created it', async () => {
    const token = await vault.unlock(userId, 'a-strong-vault-passphrase', SESSION)

    expect(vault.verify(token, userId, 'a-different-session')).toBe(false)
  })

  test('rejects a forged token', async () => {
    expect(vault.verify(`${Date.now() + 60_000}.not-a-real-signature`, userId, SESSION)).toBe(false)
  })

  test('rejects a token whose expiry has been tampered with', async () => {
    const token = await vault.unlock(userId, 'a-strong-vault-passphrase', SESSION)
    const [, signature] = token.split('.')
    const extended = `${Date.now() + 86_400_000}.${signature}`

    expect(vault.verify(extended, userId, SESSION)).toBe(false)
  })

  test('rejects an expired token', async () => {
    const token = await vault.unlock(userId, 'a-strong-vault-passphrase', SESSION, -1)

    expect(vault.verify(token, userId, SESSION)).toBe(false)
  })

  test('locks out after repeated wrong guesses', async () => {
    for (let i = 0; i < 5; i++) {
      await vault.unlock(userId, 'wrong', SESSION).catch(() => {})
    }

    // Even the correct passphrase is refused while the lockout stands.
    await expect(vault.unlock(userId, 'a-strong-vault-passphrase', SESSION)).rejects.toThrow(
      /too many/i,
    )
  })

  test('a successful unlock clears the failure count', async () => {
    await vault.unlock(userId, 'wrong', SESSION).catch(() => {})
    await vault.unlock(userId, 'a-strong-vault-passphrase', SESSION)

    const [row] = await db.select().from(users).where(eq(users.id, userId))
    expect(row!.vaultFailedAttempts).toBe(0)
  })
})

describe('moving assets in and out', () => {
  beforeEach(async () => {
    await vault.setPassphrase(userId, 'a-strong-vault-passphrase')
  })

  test('moves every asset in a selection larger than one batch', async () => {
    // A batch size of 3 against 7 assets forces the loop to run three times, proving
    // the batching itself rather than just the single-statement case.
    const batched = new VaultService(db, { secret: SECRET, batchSize: 3 })
    const seeded = await Promise.all(Array.from({ length: 7 }, () => addAsset()))

    const moved = await batched.moveIn(
      userId,
      seeded.map((a) => a.id),
    )

    expect(moved).toHaveLength(7)
    expect(new Set(moved)).toEqual(new Set(seeded.map((a) => a.id)))
    const rows = await db.select().from(assets)
    expect(rows.every((r) => r.vaultedAt !== null)).toBe(true)
  })

  test('moves an asset into the vault', async () => {
    const asset = await addAsset()

    const moved = await vault.moveIn(userId, [asset.id])

    expect(moved).toEqual([asset.id])
    const [row] = await db.select().from(assets).where(eq(assets.id, asset.id))
    expect(row!.vaultedAt).not.toBeNull()
  })

  test('moves an asset back out', async () => {
    const asset = await addAsset()
    await vault.moveIn(userId, [asset.id])

    await vault.moveOut(userId, [asset.id])

    const [row] = await db.select().from(assets).where(eq(assets.id, asset.id))
    expect(row!.vaultedAt).toBeNull()
  })

  test('cannot move another account’s asset into your vault', async () => {
    const theirs = await addAsset(otherId)

    const moved = await vault.moveIn(userId, [theirs.id])

    expect(moved).toEqual([])
    const [row] = await db.select().from(assets).where(eq(assets.id, theirs.id))
    expect(row!.vaultedAt).toBeNull()
  })

  test('cannot pull another account’s asset out of their vault', async () => {
    const theirs = await addAsset(otherId)
    await vault.moveIn(otherId, [theirs.id])

    await vault.moveOut(userId, [theirs.id])

    const [row] = await db.select().from(assets).where(eq(assets.id, theirs.id))
    expect(row!.vaultedAt).not.toBeNull()
  })

  test('lists what is in the vault', async () => {
    const a = await addAsset()
    await addAsset()
    await vault.moveIn(userId, [a.id])

    const page = await vault.list(userId, { limit: 100, sort: 'capturedAt', order: 'desc' })

    expect(page.items.map((i) => i.id)).toEqual([a.id])
  })

  test('one account cannot list another’s vault', async () => {
    const theirs = await addAsset(otherId)
    await vault.moveIn(otherId, [theirs.id])

    const page = await vault.list(userId, { limit: 100, sort: 'capturedAt', order: 'desc' })

    expect(page.items).toBeEmpty()
  })

  test('reports whether a specific asset is vaulted, for access checks', async () => {
    const asset = await addAsset()
    expect(await vault.isVaulted(asset.id)).toBe(false)

    await vault.moveIn(userId, [asset.id])

    expect(await vault.isVaulted(asset.id)).toBe(true)
  })
})
