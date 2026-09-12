import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { SettingsService } from '../admin/settings.ts'
import { SessionService } from '../auth/sessions.ts'
import type { Database } from '../db/index.ts'
import { assetFiles, assets, users } from '../db/schema.ts'
import { LocalStorage } from '../media/storage.ts'
import { createTestConfig, createTestDatabase, removeTestConfig } from '../test/harness.ts'
import { type MaintenanceDeps, sweepTrash } from './maintenance.ts'

const harness = await createTestDatabase()
const db: Database = harness.db
const config = createTestConfig()

afterAll(async () => {
  await harness.close()
  removeTestConfig(config)
})

beforeEach(async () => {
  await db.execute(sql`truncate users cascade`)
})

/** Lets a test act in the window the sweep opens between selecting a batch and reaching a row. */
class HookedStorage extends LocalStorage {
  onRemove: ((path: string) => Promise<void>) | null = null

  override async remove(path: string): Promise<void> {
    await this.onRemove?.(path)
    await super.remove(path)
  }
}

function makeDeps(): MaintenanceDeps & { library: HookedStorage } {
  const library = new HookedStorage(config.libraryDir)
  return {
    db,
    config,
    library,
    thumbnails: new LocalStorage(config.thumbsDir),
    sessions: new SessionService(db),
    settings: new SettingsService(db, { allowSignup: true, trashRetentionDays: 30 }),
  }
}

const DAY = 24 * 60 * 60 * 1000

async function makeUser(usedBytes: number) {
  const [row] = await db
    .insert(users)
    .values({ email: `${crypto.randomUUID()}@example.com`, name: 'Owner', usedBytes })
    .returning()
  return row!
}

/** A trashed asset with one original on disk. `daysAgo` is how long it has been in the trash. */
async function makeTrashedAsset(ownerId: string, daysAgo: number, sizeBytes: number) {
  const path = `${crypto.randomUUID()}.jpg`
  const [asset] = await db
    .insert(assets)
    .values({
      ownerId,
      type: 'image',
      originalFilename: 'photo.jpg',
      mimeType: 'image/jpeg',
      checksum: crypto.randomUUID(),
      sizeBytes,
      originalPath: path,
      capturedAt: new Date(),
      deletedAt: new Date(Date.now() - daysAgo * DAY),
    })
    .returning()
  await db.insert(assetFiles).values({
    assetId: asset!.id,
    variant: 'original',
    path,
    mimeType: 'image/jpeg',
    sizeBytes,
  })
  return asset!
}

const exists = (deps: MaintenanceDeps, path: string) => deps.library.exists(path)

async function restore(id: string) {
  await db.update(assets).set({ deletedAt: null }).where(eq(assets.id, id))
}

const assetById = async (id: string) => (await db.select().from(assets).where(eq(assets.id, id)))[0]
const usedBytesOf = async (id: string) =>
  (await db.select().from(users).where(eq(users.id, id)))[0]!.usedBytes

describe('sweepTrash', () => {
  test('destroys an asset past the retention window', async () => {
    const owner = await makeUser(1000)
    const doomed = await makeTrashedAsset(owner.id, 31, 400)
    const deps = makeDeps()
    await deps.library.write(doomed.originalPath, 'bytes')

    expect(await sweepTrash(deps)).toBe(1)

    expect(await assetById(doomed.id)).toBeUndefined()
    expect(await exists(deps, doomed.originalPath)).toBe(false)
    expect(await usedBytesOf(owner.id)).toBe(600)
  })

  test('leaves an asset still inside the retention window alone', async () => {
    const owner = await makeUser(1000)
    const recent = await makeTrashedAsset(owner.id, 3, 400)
    const deps = makeDeps()
    await deps.library.write(recent.originalPath, 'bytes')

    expect(await sweepTrash(deps)).toBe(0)

    expect(await assetById(recent.id)).toBeDefined()
    expect(await exists(deps, recent.originalPath)).toBe(true)
    expect(await usedBytesOf(owner.id)).toBe(1000)
  })

  // The batch select is a snapshot. Since #64 an upload of a trashed photograph restores
  // it, so a restore lands in this window without anybody clicking anything.
  test('skips an asset restored after the batch was selected', async () => {
    const owner = await makeUser(1000)
    const doomed = await makeTrashedAsset(owner.id, 40, 400)
    const rescued = await makeTrashedAsset(owner.id, 31, 100)
    const deps = makeDeps()
    await deps.library.write(doomed.originalPath, 'bytes')
    await deps.library.write(rescued.originalPath, 'bytes')

    // Oldest-first, so this fires while the sweep is on `doomed` and before it reaches
    // `rescued` — the restore the batch select could not have seen.
    deps.library.onRemove = async () => {
      deps.library.onRemove = null
      await restore(rescued.id)
    }

    expect(await sweepTrash(deps)).toBe(1)

    expect(await assetById(doomed.id)).toBeUndefined()
    const survivor = await assetById(rescued.id)
    expect(survivor).toBeDefined()
    expect(survivor!.deletedAt).toBeNull()
    expect(await exists(deps, rescued.originalPath)).toBe(true)
    expect(await usedBytesOf(owner.id)).toBe(600)
  })

  // The narrower half of the same race: the re-check passed, then the restore landed.
  // The files are already gone — files-first is deliberate — but the row must survive,
  // because its caller was told the photograph is live.
  test('keeps the row when the restore lands after the re-check', async () => {
    const owner = await makeUser(1000)
    const rescued = await makeTrashedAsset(owner.id, 31, 400)
    const deps = makeDeps()
    await deps.library.write(rescued.originalPath, 'bytes')

    deps.library.onRemove = async () => {
      deps.library.onRemove = null
      await restore(rescued.id)
    }

    expect(await sweepTrash(deps)).toBe(0)

    const survivor = await assetById(rescued.id)
    expect(survivor).toBeDefined()
    expect(survivor!.deletedAt).toBeNull()
    expect(await usedBytesOf(owner.id)).toBe(1000)
  })
})
