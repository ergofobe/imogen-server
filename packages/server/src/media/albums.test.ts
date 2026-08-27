import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { asc, eq, sql } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { albumAssets, assets, users } from '../db/schema.ts'
import { createTestDatabase } from '../test/harness.ts'
import { AlbumService } from './albums.ts'
import { AssetService } from './assets.ts'

const harness = await createTestDatabase()
const db: Database = harness.db
const service = new AlbumService(db)
const assetService = new AssetService(db)

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
async function addAsset(overrides: Partial<typeof assets.$inferInsert> = {}) {
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
      ...overrides,
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

  /**
   * `addAssets` assigns increasing `position` values batch by batch, in whatever order
   * `resolveSelection` handed it ids — the lowest position is the derived album cover.
   * Without `resolveSelection`'s own `capturedAt desc, id desc` ordering, a selection
   * spanning more than one batch would let an arbitrary database order decide which
   * batch's photos get the lowest (newest-looking) positions, rather than the actual
   * newest photo overall. Seeded out of both capture order and insertion order, so
   * either would fail this if `resolveSelection` were unordered.
   */
  test('position order reflects capture order across more than one batch', async () => {
    const album = await service.create(ownerId, { name: 'Ordered' })
    const batched = new AlbumService(db, 3)
    const dates = [
      '2024-01-10',
      '2024-05-20',
      '2024-01-01',
      '2024-06-30',
      '2024-02-14',
      '2024-04-04',
      '2024-03-01',
    ]
    const seeded = []
    for (const date of dates) {
      seeded.push(await addAsset({ capturedAt: new Date(`${date}T00:00:00Z`) }))
    }

    const ids = await assetService.resolveSelection(ownerId, { query: {} })
    await batched.addAssets(ownerId, album.id, ids)

    const rows = await db
      .select({ assetId: albumAssets.assetId, position: albumAssets.position })
      .from(albumAssets)
      .where(eq(albumAssets.albumId, album.id))
      .orderBy(asc(albumAssets.position))
    const capturedAtById = new Map(seeded.map((a) => [a.id, a.capturedAt.getTime()]))
    const orderedTimes = rows.map((r) => capturedAtById.get(r.assetId)!)

    expect(orderedTimes).toEqual([...orderedTimes].sort((a, b) => b - a))
    // The newest photo overall — 2024-06-30 — must hold the lowest position, i.e. be
    // the derived cover, not merely "newest within whichever batch it landed in".
    const newest = seeded.find((a) => a.capturedAt.toISOString().startsWith('2024-06-30'))!
    expect(rows[0]!.assetId).toBe(newest.id)
  })
})
