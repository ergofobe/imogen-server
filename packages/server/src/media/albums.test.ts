import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { asc, eq, sql } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { albumAssets, assets, users } from '../db/schema.ts'
import { COVER_SAMPLE } from '../lib/batch.ts'
import { createTestDatabase } from '../test/harness.ts'
import { AlbumService } from './albums.ts'
import { AssetService } from './assets.ts'

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

    // Forced to a sequential scan, inside its own transaction so the `SET LOCAL`s
    // cannot leak onto the shared test connection and affect any other test. Without
    // this, an index scan over `assets_timeline_idx` returns already-sorted rows for
    // free at this table size regardless of whether `resolveSelection` orders anything
    // itself — which would make every assertion below pass by planner luck rather than
    // by the code actually being correct.
    const ids = await db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_indexscan = off`)
      await tx.execute(sql`set local enable_bitmapscan = off`)
      await tx.execute(sql`set local enable_indexonlyscan = off`)
      return new AssetService(tx as unknown as Database).resolveSelection(ownerId, { query: {} })
    })
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

/**
 * `getWithAssets` used to hand back every photograph an album held, as full `Asset`
 * rows — a thirty-thousand-photograph album arrived as roughly 24 MB of JSON. The grid
 * now comes from the timeline under an `albumId` filter; this is only a cover sample.
 */
describe('the cover sample', () => {
  test('an album carries a cover sample, not every photograph it holds', async () => {
    const album = await service.create(ownerId, { name: 'Big album' })
    const seeded = await Promise.all(
      Array.from({ length: COVER_SAMPLE + 40 }, (_, i) =>
        addAsset({ capturedAt: new Date(Date.now() - i * 1000) }),
      ),
    )
    await service.addAssets(
      ownerId,
      album.id,
      seeded.map((a) => a.id),
    )

    const withAssets = await service.getWithAssets(ownerId, album.id)

    expect(withAssets.assets).toHaveLength(COVER_SAMPLE)
    for (let i = 1; i < withAssets.assets.length; i++) {
      expect(new Date(withAssets.assets[i - 1]!.capturedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(withAssets.assets[i]!.capturedAt).getTime(),
      )
    }
    // The sample is the newest ones, not an arbitrary slice — seeded[0] is the newest.
    expect(withAssets.assets[0]!.id).toBe(seeded[0]!.id)
  })
})

/**
 * What an album says it holds, against what the timeline will actually select.
 *
 * These have to be the same number, and for a while they were not. `assetCount` was a raw
 * count of `album_assets` rows — trashing a photograph leaves that row behind, archiving
 * touches nothing at all — while the grid and, worse, a select-all resolve through
 * `AssetService`'s filters, which exclude both. An album of a hundred with five in the
 * trash showed "100 photos" over ninety-five tiles and offered to move a hundred of them
 * to the trash before moving ninety-five.
 *
 * A destructive confirmation stating a number it will not honour is the single worst thing
 * this feature can do, so the agreement is asserted directly rather than inferred: the
 * album's own count, and `AssetService.timeline` under the same `albumId`, on the same
 * rows, in the same test.
 */
describe('an album counts what the timeline would show', () => {
  const countFromTimeline = async (albumId: string) => {
    const buckets = await new AssetService(db).timeline(ownerId, { albumId })
    return buckets.reduce((sum, bucket) => sum + bucket.count, 0)
  }

  test('a trashed member leaves the count, not just the grid', async () => {
    const seeded = await Promise.all(Array.from({ length: 7 }, () => addAsset()))
    const album = await service.create(ownerId, {
      name: 'Holiday',
      assetIds: seeded.map((a) => a.id),
    })
    expect((await service.get(ownerId, album.id)).assetCount).toBe(7)

    await db.update(assets).set({ deletedAt: new Date() }).where(eq(assets.id, seeded[0]!.id))

    expect((await service.get(ownerId, album.id)).assetCount).toBe(6)
    expect(await countFromTimeline(album.id)).toBe(6)
  })

  test('an archived member leaves it too', async () => {
    const seeded = await Promise.all(Array.from({ length: 7 }, () => addAsset()))
    const album = await service.create(ownerId, {
      name: 'Holiday',
      assetIds: seeded.map((a) => a.id),
    })

    await db.update(assets).set({ archived: true }).where(eq(assets.id, seeded[1]!.id))

    expect((await service.get(ownerId, album.id)).assetCount).toBe(6)
    expect(await countFromTimeline(album.id)).toBe(6)
  })

  test('and a vaulted one, which is the whole point of the vault', async () => {
    const seeded = await Promise.all(Array.from({ length: 7 }, () => addAsset()))
    const album = await service.create(ownerId, {
      name: 'Holiday',
      assetIds: seeded.map((a) => a.id),
    })

    await db.update(assets).set({ vaultedAt: new Date() }).where(eq(assets.id, seeded[2]!.id))

    expect((await service.get(ownerId, album.id)).assetCount).toBe(6)
    expect(await countFromTimeline(album.id)).toBe(6)
  })

  /*
   * All three at once, and the listing as well as the single album. `list` builds its count
   * as an aggregate over a LEFT join rather than through `inAlbum` directly — it has to, or
   * an empty album would vanish from the listing — so it is a second copy of the same rule
   * and the one most likely to drift away from the first.
   */
  test('the album listing agrees with the album, and both agree with the timeline', async () => {
    const seeded = await Promise.all(Array.from({ length: 9 }, () => addAsset()))
    const album = await service.create(ownerId, {
      name: 'Holiday',
      assetIds: seeded.map((a) => a.id),
    })
    const empty = await service.create(ownerId, { name: 'Nothing in here' })

    await db.update(assets).set({ deletedAt: new Date() }).where(eq(assets.id, seeded[0]!.id))
    await db.update(assets).set({ archived: true }).where(eq(assets.id, seeded[1]!.id))
    await db.update(assets).set({ vaultedAt: new Date() }).where(eq(assets.id, seeded[2]!.id))

    const listed = await service.list(ownerId)
    const holiday = listed.find((a) => a.id === album.id)

    expect(holiday?.assetCount).toBe(6)
    expect((await service.get(ownerId, album.id)).assetCount).toBe(6)
    expect(await countFromTimeline(album.id)).toBe(6)
    // The LEFT join has to survive an album with no members at all.
    expect(listed.find((a) => a.id === empty.id)?.assetCount).toBe(0)
  })

  test('the cover sample is drawn from the same rows the count counts', async () => {
    const seeded = await Promise.all(Array.from({ length: 5 }, () => addAsset()))
    const album = await service.create(ownerId, {
      name: 'Holiday',
      assetIds: seeded.map((a) => a.id),
    })

    await db.update(assets).set({ archived: true }).where(eq(assets.id, seeded[0]!.id))

    const withAssets = await service.getWithAssets(ownerId, album.id)
    expect(withAssets.assets).toHaveLength(4)
    expect(withAssets.assets.map((a) => a.id)).not.toContain(seeded[0]!.id)
    expect(withAssets.assetCount).toBe(4)
  })
})
