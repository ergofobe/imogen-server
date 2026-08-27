import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { assets, users } from '../db/schema.ts'
import { createTestDatabase } from '../test/harness.ts'
import { AlbumService } from './albums.ts'

const harness = await createTestDatabase()
const db: Database = harness.db
const service = new AlbumService(db)

afterAll(() => harness.close())

let ownerId: string

beforeEach(async () => {
  await db.execute(sql`truncate assets, users cascade`)
  const [row] = await db
    .insert(users)
    .values({ email: 'owner@example.com', name: 'Owner' })
    .returning()
  ownerId = row!.id
})

let counter = 0
async function addAsset() {
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
      sizeBytes: 1000,
      originalPath: `x/${counter}.jpg`,
      capturedAt: new Date(),
    })
    .returning()
  return row!
}

/**
 * A query-resolved selection can outrun a single statement's bind-parameter limit, so
 * both `addAssets` and `removeAssets` process ids in batches. These tests force the loop
 * to run several times with a tiny batch size, rather than seeding thousands of real
 * rows to reach the production batch size.
 */
describe('adding and removing assets in batches', () => {
  test('adds every asset in a selection larger than one batch', async () => {
    const album = await service.create(ownerId, { name: 'Big album' })
    const batched = new AlbumService(db, 3)
    const seeded = await Promise.all(Array.from({ length: 7 }, () => addAsset()))

    const result = await batched.addAssets(
      ownerId,
      album.id,
      seeded.map((a) => a.id),
    )

    expect(result.added).toBe(7)
    expect(result.skipped).toBe(0)
    expect(result.assetCount).toBe(7)
    const withAssets = await service.getWithAssets(ownerId, album.id)
    expect(withAssets.assets.map((a) => a.id).sort()).toEqual(seeded.map((a) => a.id).sort())
  })

  test('removes every asset in a selection larger than one batch', async () => {
    const seeded = await Promise.all(Array.from({ length: 7 }, () => addAsset()))
    const album = await service.create(ownerId, {
      name: 'Big album',
      assetIds: seeded.map((a) => a.id),
    })
    const batched = new AlbumService(db, 3)

    const removed = await batched.removeAssets(
      ownerId,
      album.id,
      seeded.map((a) => a.id),
    )

    expect(removed).toBe(7)
    const withAssets = await service.getWithAssets(ownerId, album.id)
    expect(withAssets.assets).toBeEmpty()
  })
})
