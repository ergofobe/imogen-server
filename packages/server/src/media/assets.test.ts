import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { albumAssets, albums, assets, faces, people, users } from '../db/schema.ts'
import { HttpError } from '../lib/errors.ts'
import { createTestDatabase } from '../test/harness.ts'
import { AssetService } from './assets.ts'

const harness = await createTestDatabase()
const db: Database = harness.db
const service = new AssetService(db)

afterAll(() => harness.close())

let ownerId: string
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
  ownerId = rows[0]!.id
  otherId = rows[1]!.id
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
      capturedAt: new Date(`2024-01-${String((counter % 28) + 1).padStart(2, '0')}T12:00:00Z`),
      ...overrides,
    })
    .returning()
  return row!
}

async function seed(owner: string, overridesList: Partial<typeof assets.$inferInsert>[]) {
  const rows = []
  for (const overrides of overridesList) {
    rows.push(await addAsset({ ownerId: owner, ...overrides }))
  }
  return rows
}

async function seedOwner(): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email: `stranger-${randomUUID()}@example.com`, name: 'Stranger' })
    .returning()
  return row!.id
}

async function seedAlbum(owner: string, overridesList: Partial<typeof assets.$inferInsert>[]) {
  const [album] = await db.insert(albums).values({ ownerId: owner, name: 'Album' }).returning()
  const assetRows = await seed(owner, overridesList)
  await db
    .insert(albumAssets)
    .values(assetRows.map((row, position) => ({ albumId: album!.id, assetId: row.id, position })))
  return album!.id
}

/** A face of one person on one asset. The embedding is a placeholder — nothing here reads it. */
async function seedFace(owner: string, personId: string, assetId: string) {
  await db.insert(faces).values({
    assetId,
    ownerId: owner,
    personId,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    score: 0.9,
    embedding: Array(512).fill(0),
  })
}

describe('listing', () => {
  test('returns only the caller’s own assets', async () => {
    await addAsset()
    await addAsset({ ownerId: otherId, checksum: 'f'.repeat(64) })

    const page = await service.list(ownerId, { limit: 100, sort: 'capturedAt', order: 'desc' })

    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.ownerId).toBe(ownerId)
  })

  test('sorts newest first by capture time', async () => {
    await addAsset({ capturedAt: new Date('2020-01-01T00:00:00Z') })
    await addAsset({ capturedAt: new Date('2024-06-01T00:00:00Z') })
    await addAsset({ capturedAt: new Date('2022-03-01T00:00:00Z') })

    const page = await service.list(ownerId, { limit: 100, sort: 'capturedAt', order: 'desc' })

    expect(page.items.map((a) => a.capturedAt.slice(0, 4))).toEqual(['2024', '2022', '2020'])
  })

  test('hides trashed assets by default', async () => {
    await addAsset()
    await addAsset({ deletedAt: new Date() })

    const page = await service.list(ownerId, { limit: 100, sort: 'capturedAt', order: 'desc' })

    expect(page.items).toHaveLength(1)
  })

  test('shows only trashed assets when asked', async () => {
    await addAsset()
    const trashed = await addAsset({ deletedAt: new Date() })

    const page = await service.list(ownerId, {
      limit: 100,
      sort: 'capturedAt',
      order: 'desc',
      trashed: true,
    })

    expect(page.items.map((a) => a.id)).toEqual([trashed.id])
  })

  test('hides archived assets from the main timeline', async () => {
    await addAsset()
    await addAsset({ archived: true })

    const page = await service.list(ownerId, { limit: 100, sort: 'capturedAt', order: 'desc' })

    expect(page.items).toHaveLength(1)
  })

  test('filters by favourite', async () => {
    await addAsset()
    const favourite = await addAsset({ favorite: true })

    const page = await service.list(ownerId, {
      limit: 100,
      sort: 'capturedAt',
      order: 'desc',
      favorite: true,
    })

    expect(page.items.map((a) => a.id)).toEqual([favourite.id])
  })

  test('filters by media type', async () => {
    await addAsset()
    const video = await addAsset({ type: 'video', mimeType: 'video/mp4' })

    const page = await service.list(ownerId, {
      limit: 100,
      sort: 'capturedAt',
      order: 'desc',
      type: 'video',
    })

    expect(page.items.map((a) => a.id)).toEqual([video.id])
  })

  test('filters by the person appearing in the photo, once per asset regardless of face count', async () => {
    const [withPerson, withoutPerson] = await seed(ownerId, [
      { capturedAt: new Date('2011-08-14T09:00:00Z') },
      { capturedAt: new Date('2011-08-15T09:00:00Z') },
    ])
    const [person] = await db.insert(people).values({ ownerId }).returning()
    // Two faces of the same person on the same asset — the exists() semi-join must not
    // duplicate the asset in the results.
    await seedFace(ownerId, person!.id, withPerson!.id)
    await seedFace(ownerId, person!.id, withPerson!.id)
    void withoutPerson

    const page = await service.list(ownerId, {
      limit: 100,
      sort: 'capturedAt',
      order: 'desc',
      personId: person!.id,
    })

    expect(page.items.map((a) => a.id)).toEqual([withPerson!.id])
  })

  test('filters by capture date range', async () => {
    await addAsset({ capturedAt: new Date('2020-05-05T00:00:00Z') })
    const inRange = await addAsset({ capturedAt: new Date('2023-05-05T00:00:00Z') })
    await addAsset({ capturedAt: new Date('2025-05-05T00:00:00Z') })

    const page = await service.list(ownerId, {
      limit: 100,
      sort: 'capturedAt',
      order: 'desc',
      takenAfter: '2023-01-01T00:00:00.000Z',
      takenBefore: '2024-01-01T00:00:00.000Z',
    })

    expect(page.items.map((a) => a.id)).toEqual([inRange.id])
  })
})

describe('cursor pagination', () => {
  test('walks the whole library exactly once', async () => {
    for (let i = 0; i < 25; i++) {
      await addAsset({ capturedAt: new Date(Date.UTC(2024, 0, 1, 0, 0, i)) })
    }

    const seen: string[] = []
    let cursor: string | null = null
    do {
      const page: Awaited<ReturnType<typeof service.list>> = await service.list(ownerId, {
        limit: 10,
        sort: 'capturedAt',
        order: 'desc',
        ...(cursor ? { cursor } : {}),
      })
      seen.push(...page.items.map((a) => a.id))
      cursor = page.nextCursor
    } while (cursor)

    expect(seen).toHaveLength(25)
    expect(new Set(seen).size).toBe(25)
  })

  test('does not skip or repeat when assets share a capture time', async () => {
    const sameMoment = new Date('2024-02-02T10:00:00Z')
    for (let i = 0; i < 12; i++) await addAsset({ capturedAt: sameMoment })

    const seen: string[] = []
    let cursor: string | null = null
    do {
      const page: Awaited<ReturnType<typeof service.list>> = await service.list(ownerId, {
        limit: 5,
        sort: 'capturedAt',
        order: 'desc',
        ...(cursor ? { cursor } : {}),
      })
      seen.push(...page.items.map((a) => a.id))
      cursor = page.nextCursor
    } while (cursor)

    expect(new Set(seen).size).toBe(12)
  })

  test('reports no next cursor on the final page', async () => {
    await addAsset()
    await addAsset()

    const page = await service.list(ownerId, { limit: 10, sort: 'capturedAt', order: 'desc' })

    expect(page.nextCursor).toBeNull()
  })

  test('an upload during paging does not shift the pages already read', async () => {
    for (let i = 0; i < 10; i++) {
      await addAsset({ capturedAt: new Date(Date.UTC(2024, 0, 1, 0, 0, i)) })
    }
    const first = await service.list(ownerId, { limit: 5, sort: 'capturedAt', order: 'desc' })

    // Something newer arrives between pages, as it would mid-scroll.
    await addAsset({ capturedAt: new Date(Date.UTC(2030, 0, 1)) })

    const second = await service.list(ownerId, {
      limit: 5,
      sort: 'capturedAt',
      order: 'desc',
      cursor: first.nextCursor!,
    })

    const overlap = second.items.filter((a) => first.items.some((f) => f.id === a.id))
    expect(overlap).toBeEmpty()
  })
})

describe('search', () => {
  test('matches on filename', async () => {
    await addAsset({ originalFilename: 'harbour-sunset.jpg' })
    await addAsset({ originalFilename: 'tax-return.jpg' })

    const page = await service.list(ownerId, {
      limit: 100,
      sort: 'capturedAt',
      order: 'desc',
      q: 'harbour',
    })

    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.originalFilename).toBe('harbour-sunset.jpg')
  })

  test('matches on description', async () => {
    const described = await addAsset({ description: 'The dog wearing a party hat' })
    await addAsset({ description: 'A spreadsheet' })

    const page = await service.list(ownerId, {
      limit: 100,
      sort: 'capturedAt',
      order: 'desc',
      q: 'dog',
    })

    expect(page.items.map((a) => a.id)).toEqual([described.id])
  })

  test('matches on camera model', async () => {
    const shot = await addAsset({ exif: { make: 'Fujifilm', model: 'X100V' } })
    await addAsset({ exif: { make: 'Apple', model: 'iPhone 15' } })

    const page = await service.list(ownerId, {
      limit: 100,
      sort: 'capturedAt',
      order: 'desc',
      q: 'Fujifilm',
    })

    expect(page.items.map((a) => a.id)).toEqual([shot.id])
  })

  test('never leaks another user’s assets through search', async () => {
    await addAsset({
      ownerId: otherId,
      originalFilename: 'secret-harbour.jpg',
      checksum: 'a'.repeat(64),
    })

    const page = await service.list(ownerId, {
      limit: 100,
      sort: 'capturedAt',
      order: 'desc',
      q: 'harbour',
    })

    expect(page.items).toBeEmpty()
  })

  test('treats punctuation as harmless rather than as query syntax', async () => {
    await addAsset({ originalFilename: 'holiday.jpg' })

    // A raw tsquery would reject these; the service must not hand user text to to_tsquery.
    const page = await service.list(ownerId, {
      limit: 100,
      sort: 'capturedAt',
      order: 'desc',
      q: 'holiday & | ! ( ) :*',
    })

    expect(page.items).toHaveLength(1)
  })
})

describe('mutation', () => {
  test('updates favourite and description', async () => {
    const asset = await addAsset()

    const updated = await service.update(ownerId, asset.id, {
      favorite: true,
      description: 'A very good dog',
    })

    expect(updated.favorite).toBe(true)
    expect(updated.description).toBe('A very good dog')
  })

  test('refuses to update another user’s asset', async () => {
    const asset = await addAsset({ ownerId: otherId, checksum: 'b'.repeat(64) })

    await expect(service.update(ownerId, asset.id, { favorite: true })).rejects.toThrow()
  })

  test('trashing sets a deletion time rather than destroying the row', async () => {
    const asset = await addAsset()

    await service.trash(ownerId, [asset.id])

    const [row] = await db.select().from(assets)
    expect(row!.deletedAt).not.toBeNull()
  })

  test('restoring clears the deletion time', async () => {
    const asset = await addAsset({ deletedAt: new Date() })

    await service.restore(ownerId, [asset.id])

    const [row] = await db.select().from(assets)
    expect(row!.deletedAt).toBeNull()
  })

  test('trashing another user’s asset does nothing', async () => {
    const asset = await addAsset({ ownerId: otherId, checksum: 'c'.repeat(64) })

    await service.trash(ownerId, [asset.id])

    const [row] = await db.select().from(assets)
    expect(row!.deletedAt).toBeNull()
  })
})

describe('selections by query', () => {
  const listAll = () => service.list(ownerId, { limit: 100, sort: 'capturedAt', order: 'desc' })

  test('trashes everything a filter matches', async () => {
    await seed(ownerId, [
      { capturedAt: new Date('2011-08-14T09:00:00Z'), favorite: true },
      { capturedAt: new Date('2011-08-15T09:00:00Z'), favorite: true },
      { capturedAt: new Date('2011-08-16T09:00:00Z'), favorite: false },
    ])
    expect(await service.trashSelection(ownerId, { query: { favorite: true } })).toBe(2)
    expect((await listAll()).items).toHaveLength(1)
  })

  test('honours the exclusion set', async () => {
    await seed(ownerId, [
      { capturedAt: new Date('2011-08-14T09:00:00Z'), favorite: true },
      { capturedAt: new Date('2011-08-15T09:00:00Z'), favorite: true },
    ])
    const [keep] = (await listAll()).items
    expect(
      await service.trashSelection(ownerId, { query: { favorite: true }, except: [keep!.id] }),
    ).toBe(1)
    expect((await listAll()).items[0]!.id).toBe(keep!.id)
  })

  test('never reaches another owner', async () => {
    const stranger = await seedOwner()
    await seed(stranger, [{ capturedAt: new Date('2011-08-14T09:00:00Z'), favorite: true }])
    await seed(ownerId, [{ capturedAt: new Date('2011-08-14T09:00:00Z'), favorite: true }])
    expect(await service.trashSelection(ownerId, { query: { favorite: true } })).toBe(1)
  })

  test('never reaches the vault', async () => {
    await seed(ownerId, [
      { capturedAt: new Date('2011-08-14T09:00:00Z'), favorite: true, vaultedAt: new Date() },
    ])
    expect(await service.trashSelection(ownerId, { query: { favorite: true } })).toBe(0)
  })

  test('the id form still works exactly as it did', async () => {
    await seed(ownerId, [{ capturedAt: new Date('2011-08-14T09:00:00Z') }])
    const [only] = (await listAll()).items
    expect(await service.trashSelection(ownerId, { assetIds: [only!.id] })).toBe(1)
  })

  /**
   * The other half of what `never reaches the vault` states. A QUERY is parsed from a URL,
   * so it must never reach a vaulted photograph however it is phrased. An explicit id list
   * is a different act: the caller is naming one photograph it already had to get past the
   * vault's gate to see, and the vault's own viewer trashes exactly that way. Refusing it
   * made the trash button inside the vault do nothing at all, and say nothing about it.
   */
  test('the id form reaches into the vault, because the caller named the photograph', async () => {
    const [vaulted] = await seed(ownerId, [
      { capturedAt: new Date('2011-08-14T09:00:00Z'), vaultedAt: new Date() },
    ])
    expect(await service.trashSelection(ownerId, { assetIds: [vaulted!.id] })).toBe(1)
    const [row] = await db.select().from(assets).where(eq(assets.id, vaulted!.id))
    expect(row!.deletedAt).not.toBeNull()
    // Trashed, still vaulted: trashing does not tip the vault out into the library.
    expect(row!.vaultedAt).not.toBeNull()
  })

  /**
   * The tempting way to fix the above is to drop the vault predicate rather than to move it
   * onto the id branch alone — which opens the query branch at the same time. These two say
   * the query branch is still shut, and both would fail if `isNull(assets.vaultedAt)` were
   * simply deleted from `buildFilters` instead.
   */
  test('a query still cannot trash a vaulted photograph, even as the only match', async () => {
    const [vaulted] = await seed(ownerId, [
      { capturedAt: new Date('2011-08-14T09:00:00Z'), favorite: true, vaultedAt: new Date() },
    ])
    expect(await service.trashSelection(ownerId, { query: { favorite: true } })).toBe(0)
    const [row] = await db.select().from(assets).where(eq(assets.id, vaulted!.id))
    expect(row!.deletedAt).toBeNull()
  })

  test('a query for the trash still cannot restore a vaulted photograph', async () => {
    const [vaulted] = await seed(ownerId, [
      {
        capturedAt: new Date('2011-08-14T09:00:00Z'),
        vaultedAt: new Date(),
        deletedAt: new Date(),
      },
    ])
    expect(await service.restoreSelection(ownerId, { query: { trashed: true } })).toBe(0)
    const [row] = await db.select().from(assets).where(eq(assets.id, vaulted!.id))
    expect(row!.deletedAt).not.toBeNull()
  })

  test('the id form restores a photograph that is both trashed and vaulted', async () => {
    const [vaulted] = await seed(ownerId, [
      {
        capturedAt: new Date('2011-08-14T09:00:00Z'),
        vaultedAt: new Date(),
        deletedAt: new Date(),
      },
    ])
    expect(await service.restoreSelection(ownerId, { assetIds: [vaulted!.id] })).toBe(1)
    const [row] = await db.select().from(assets).where(eq(assets.id, vaulted!.id))
    expect(row!.deletedAt).toBeNull()
    expect(row!.vaultedAt).not.toBeNull()
  })

  /**
   * `the id form still works exactly as it did`, above, only ever trashes the caller's
   * own asset — it would pass even without `eq(assets.ownerId, ownerId)` in the id
   * branch. This is the id-form counterpart of `never reaches another owner`.
   */
  test('the id form never reaches another owner either', async () => {
    const stranger = await seedOwner()
    const [theirs] = await seed(stranger, [{ capturedAt: new Date('2011-08-14T09:00:00Z') }])
    expect(await service.trashSelection(ownerId, { assetIds: [theirs!.id] })).toBe(0)
    const [row] = await db.select().from(assets).where(eq(assets.id, theirs!.id))
    expect(row!.deletedAt).toBeNull()
  })

  test('restores by query, from the trash', async () => {
    await seed(ownerId, [{ capturedAt: new Date('2011-08-14T09:00:00Z'), favorite: true }])
    await service.trashSelection(ownerId, { query: { favorite: true } })
    expect(
      await service.restoreSelection(ownerId, { query: { favorite: true, trashed: true } }),
    ).toBe(1)
  })

  /**
   * `trashSelection` has always guarded with `isNull(deletedAt)`; restore had no
   * counterpart. Ten ids of which two were in the trash cleared `deletedAt` on all ten and
   * answered ten — and the count is exactly what the UI reads back to the reader.
   */
  test('restoring counts what it actually restored, not what it was handed', async () => {
    const [trashed, untouched] = await seed(ownerId, [
      { capturedAt: new Date('2011-08-14T09:00:00Z'), deletedAt: new Date() },
      { capturedAt: new Date('2011-08-15T09:00:00Z') },
    ])
    expect(
      await service.restoreSelection(ownerId, { assetIds: [trashed!.id, untouched!.id] }),
    ).toBe(1)
    const [row] = await db.select().from(assets).where(eq(assets.id, trashed!.id))
    expect(row!.deletedAt).toBeNull()
  })

  /** And the ones it had no business touching are not touched: no spurious `updatedAt`. */
  test('restoring leaves a photograph that was never in the trash alone', async () => {
    const [untouched] = await seed(ownerId, [{ capturedAt: new Date('2011-08-15T09:00:00Z') }])
    await service.restoreSelection(ownerId, { assetIds: [untouched!.id] })
    const [row] = await db.select().from(assets).where(eq(assets.id, untouched!.id))
    expect(row!.updatedAt).toEqual(untouched!.updatedAt)
  })
})

describe('resolving a selection to ids', () => {
  test('a query resolves to the matching, visible ids', async () => {
    const [favored] = await seed(ownerId, [
      { capturedAt: new Date('2011-08-14T09:00:00Z'), favorite: true },
      { capturedAt: new Date('2011-08-15T09:00:00Z'), favorite: false },
    ])
    expect(await service.resolveSelection(ownerId, { query: { favorite: true } })).toEqual([
      favored!.id,
    ])
  })

  /**
   * An id list passes straight through unfiltered — including into the vault. Album
   * membership and trash both re-check ownership and vault status themselves, and the
   * vault's own move-out route sends exactly the ids of assets that are already vaulted:
   * running that list past the ordinary vault-exclusive filter would silently resolve to
   * nothing, breaking the one direction a vaulted photograph is supposed to be reachable.
   */
  test('an id list passes straight through, even into the vault', async () => {
    const vaulted = await addAsset({ vaultedAt: new Date() })
    expect(await service.resolveSelection(ownerId, { assetIds: [vaulted.id] })).toEqual([
      vaulted.id,
    ])
  })
})

describe('timeline buckets', () => {
  test('counts assets per day, newest first', async () => {
    await addAsset({ capturedAt: new Date('2024-03-01T09:00:00Z') })
    await addAsset({ capturedAt: new Date('2024-03-01T18:00:00Z') })
    await addAsset({ capturedAt: new Date('2024-03-05T12:00:00Z') })

    const buckets = await service.timeline(ownerId)

    expect(buckets).toEqual([
      { date: '2024-03-05', count: 1, coverAssetId: null },
      { date: '2024-03-01', count: 2, coverAssetId: null },
    ])
  })

  test('excludes trashed assets from the buckets', async () => {
    await addAsset({ capturedAt: new Date('2024-03-01T09:00:00Z') })
    await addAsset({ capturedAt: new Date('2024-03-01T10:00:00Z'), deletedAt: new Date() })

    const buckets = await service.timeline(ownerId)

    expect(buckets).toEqual([{ date: '2024-03-01', count: 1, coverAssetId: null }])
  })

  test('a bucket carries every tile in its month, newest first', async () => {
    await seed(ownerId, [
      { capturedAt: new Date('2011-08-14T09:00:00Z') },
      { capturedAt: new Date('2011-08-14T18:00:00Z') },
      { capturedAt: new Date('2011-09-02T09:00:00Z') },
    ])
    const page = await service.bucket(ownerId, { period: '2011-08', limit: 5000 })
    expect(page.items).toHaveLength(2)
    expect(page.items[0]!.capturedAt).toBe('2011-08-14T18:00:00.000Z')
    expect(page.total).toBe(2)
    expect(page.nextCursor).toBeNull()
  })

  test('a bucket accepts a single day as well as a month', async () => {
    await seed(ownerId, [
      { capturedAt: new Date('2011-08-14T09:00:00Z') },
      { capturedAt: new Date('2011-08-15T09:00:00Z') },
    ])
    const page = await service.bucket(ownerId, { period: '2011-08-14', limit: 5000 })
    expect(page.items).toHaveLength(1)
  })

  /**
   * `TimelineBucketQuery`'s regex is happy with any two digits and `Date.UTC` rolls the
   * out-of-range ones over rather than complaining, so `2011-13` used to answer 200 with
   * January 2012's tiles and a total to match: a client's off-by-one became wrong data
   * instead of a rejected request. Each of these seeds the period it would have rolled
   * into, so a rollover that survives would answer with a photograph rather than nothing.
   */
  const impossiblePeriods = [
    ['2011-13', new Date('2012-01-14T09:00:00Z')],
    ['2011-00', new Date('2010-12-14T09:00:00Z')],
    ['2011-02-30', new Date('2011-03-02T09:00:00Z')],
    ['2011-04-31', new Date('2011-05-01T09:00:00Z')],
    ['2011-08-00', new Date('2011-07-31T09:00:00Z')],
    ['2023-02-29', new Date('2023-03-01T09:00:00Z')],
  ] as const

  for (const [period, wouldHaveRolledInto] of impossiblePeriods) {
    test(`refuses ${period} rather than rolling it over`, async () => {
      await seed(ownerId, [{ capturedAt: wouldHaveRolledInto }])
      const thrown = await service
        .bucket(ownerId, { period, limit: 5000 })
        .catch((error: unknown) => error)
      expect(thrown).toBeInstanceOf(HttpError)
      // 400, the same as every other rejected request — not a 500 and not a 200.
      expect((thrown as HttpError).status).toBe(400)
    })
  }

  test('29 February in a leap year is a real day', async () => {
    await seed(ownerId, [
      { capturedAt: new Date('2024-02-29T09:00:00Z') },
      { capturedAt: new Date('2024-02-28T09:00:00Z') },
    ])
    const page = await service.bucket(ownerId, { period: '2024-02-29', limit: 5000 })
    expect(page.items).toHaveLength(1)
    expect(page.total).toBe(1)
  })

  test('the last day of a 31-day month, and the twelfth month, are both still fine', async () => {
    await seed(ownerId, [{ capturedAt: new Date('2011-12-31T09:00:00Z') }])
    expect(
      (await service.bucket(ownerId, { period: '2011-12-31', limit: 5000 })).items,
    ).toHaveLength(1)
    expect((await service.bucket(ownerId, { period: '2011-12', limit: 5000 })).items).toHaveLength(
      1,
    )
    expect((await service.bucket(ownerId, { period: '2011-01', limit: 5000 })).items).toHaveLength(
      0,
    )
  })

  test('a bucket pages when a period holds more than the limit', async () => {
    await seed(
      ownerId,
      Array.from({ length: 5 }, (_, i) => ({
        capturedAt: new Date(`2011-08-1${i}T09:00:00Z`),
      })),
    )
    const first = await service.bucket(ownerId, { period: '2011-08', limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    const second = await service.bucket(ownerId, {
      period: '2011-08',
      limit: 2,
      cursor: first.nextCursor!,
    })
    expect(second.items).toHaveLength(2)
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id)

    // The total is the whole period, not "whatever is left after the cursor" — a future
    // refactor that reuses the paged condition list for the count would shrink this.
    expect(first.total).toBe(5)
    expect(second.total).toBe(5)
  })

  test('the cursor tie-breaks by id when many assets share one capturedAt', async () => {
    // A bulk import is exactly what produces thousands of identical timestamps. If the
    // cursor predicate degrades into an AND of two independent conditions instead of a
    // true tuple comparison, rows sharing the boundary's timestamp go missing.
    const sameMoment = new Date('2011-08-14T09:00:00Z')
    const seeded = await seed(
      ownerId,
      Array.from({ length: 5 }, () => ({ capturedAt: sameMoment })),
    )

    let page = await service.bucket(ownerId, { period: '2011-08', limit: 2 })
    const seen = [...page.items.map((t) => t.id)]
    while (page.nextCursor) {
      page = await service.bucket(ownerId, {
        period: '2011-08',
        limit: 2,
        cursor: page.nextCursor,
      })
      seen.push(...page.items.map((t) => t.id))
    }

    expect(page.nextCursor).toBeNull()
    expect(seen).toHaveLength(5)
    expect(new Set(seen).size).toBe(5)
    expect(new Set(seen)).toEqual(new Set(seeded.map((r) => r.id)))
  })

  test('period intersects takenAfter rather than widening it', async () => {
    await seed(ownerId, [
      { capturedAt: new Date('2011-08-05T09:00:00Z') },
      { capturedAt: new Date('2011-08-25T09:00:00Z') },
    ])
    const page = await service.bucket(ownerId, {
      period: '2011-08',
      limit: 5000,
      takenAfter: '2011-08-20T00:00:00.000Z',
    })
    expect(page.items).toHaveLength(1)
  })

  test('a bucket keeps the vault out, like every other listing', async () => {
    await seed(ownerId, [{ capturedAt: new Date('2011-08-14T09:00:00Z'), vaultedAt: new Date() }])
    const page = await service.bucket(ownerId, { period: '2011-08', limit: 5000 })
    expect(page.items).toHaveLength(0)
  })

  test('buckets narrow to an album when asked', async () => {
    const albumId = await seedAlbum(ownerId, [{ capturedAt: new Date('2011-08-14T09:00:00Z') }])
    await seed(ownerId, [{ capturedAt: new Date('2011-08-15T09:00:00Z') }])
    const buckets = await service.timeline(ownerId, { albumId })
    expect(buckets).toEqual([{ date: '2011-08-14', count: 1, coverAssetId: null }])
  })

  test('covers name the newest ready asset, and fall back as ready assets are removed', async () => {
    // Two ready assets, so a naive min(id) or ascending pick would still pass with only
    // one — the newest-by-capturedAt ordering only shows up with two to choose between.
    const [older, newer] = await seed(ownerId, [
      { capturedAt: new Date('2011-08-14T09:00:00Z'), status: 'ready' },
      { capturedAt: new Date('2011-08-14T14:00:00Z'), status: 'ready' },
    ])
    // Newest overall, but not ready — must not be picked over an older ready asset.
    await seed(ownerId, [{ capturedAt: new Date('2011-08-14T18:00:00Z'), status: 'processing' }])

    const [bucket] = await service.timeline(ownerId, { covers: true })
    expect(bucket!.coverAssetId).toBe(newer!.id)

    await service.trash(ownerId, [newer!.id])
    const [afterNewerGone] = await service.timeline(ownerId, { covers: true })
    expect(afterNewerGone!.coverAssetId).toBe(older!.id)

    await service.trash(ownerId, [older!.id])
    const [afterBothGone] = await service.timeline(ownerId, { covers: true })
    expect(afterBothGone!.coverAssetId).toBeNull()
  })

  test('a timeline with no filters answers exactly as it did before', async () => {
    await seed(ownerId, [{ capturedAt: new Date('2011-08-14T09:00:00Z') }])
    expect(await service.timeline(ownerId, {})).toEqual([
      { date: '2011-08-14', count: 1, coverAssetId: null },
    ])
  })

  test('a tile carries each of its fields in the right place', async () => {
    const livePhotoVideoId = randomUUID()
    const [row] = await seed(ownerId, [
      {
        capturedAt: new Date('2011-08-14T09:00:00Z'),
        type: 'video',
        status: 'ready',
        favorite: true,
        width: 800,
        height: 600,
        duration: 12.5,
        placeholderColor: '#abcdef',
        livePhotoVideoId,
      },
    ])

    const page = await service.bucket(ownerId, { period: '2011-08', limit: 10 })
    const tile = page.items[0]!

    expect(tile.id).toBe(row!.id)
    expect(tile.capturedAt).toBe('2011-08-14T09:00:00.000Z')
    expect(tile.type).toBe('video')
    expect(tile.status).toBe('ready')
    expect(tile.favorite).toBe(true)
    expect(tile.width).toBe(800)
    expect(tile.height).toBe(600)
    expect(tile.duration).toBe(12.5)
    expect(tile.placeholderColor).toBe('#abcdef')
    expect(tile.livePhotoVideoId).toBe(livePhotoVideoId)
  })
})

describe('statistics', () => {
  test('summarises the library', async () => {
    await addAsset({ sizeBytes: 100, capturedAt: new Date('2020-01-01T00:00:00Z') })
    await addAsset({
      sizeBytes: 200,
      type: 'video',
      favorite: true,
      capturedAt: new Date('2024-01-01T00:00:00Z'),
    })
    await addAsset({ sizeBytes: 400, deletedAt: new Date() })

    const stats = await service.stats(ownerId)

    expect(stats.assetCount).toBe(2)
    expect(stats.imageCount).toBe(1)
    expect(stats.videoCount).toBe(1)
    expect(stats.favoriteCount).toBe(1)
    expect(stats.trashedCount).toBe(1)
    expect(stats.storageBytes).toBe(300)
    expect(stats.earliestCapturedAt).toStartWith('2020-01-01')
  })
})

describe('correcting the capture date', () => {
  test('keeps the date the file gave us, so the edit can be undone', async () => {
    const row = await addAsset({ capturedAt: new Date('2019-07-04T11:22:33Z') })

    const edited = await service.update(ownerId, row.id, {
      capturedAt: '2019-07-04T15:22:33.000Z',
    })

    expect(edited.capturedAt).toBe('2019-07-04T15:22:33.000Z')
    expect(edited.capturedAtOriginal).toBe('2019-07-04T11:22:33.000Z')
  })

  test('a second edit does not overwrite the original', async () => {
    const row = await addAsset({ capturedAt: new Date('2019-07-04T11:22:33Z') })

    await service.update(ownerId, row.id, { capturedAt: '2020-01-01T00:00:00.000Z' })
    const twice = await service.update(ownerId, row.id, { capturedAt: '2021-01-01T00:00:00.000Z' })

    expect(twice.capturedAt).toBe('2021-01-01T00:00:00.000Z')
    expect(twice.capturedAtOriginal).toBe('2019-07-04T11:22:33.000Z')
  })

  test('reverting puts the file’s own date back', async () => {
    const row = await addAsset({ capturedAt: new Date('2019-07-04T11:22:33Z') })
    await service.update(ownerId, row.id, { capturedAt: '2020-01-01T00:00:00.000Z' })

    const reverted = await service.update(ownerId, row.id, { resetCapturedAt: true })

    expect(reverted.capturedAt).toBe('2019-07-04T11:22:33.000Z')
    expect(reverted.capturedAtOriginal).toBeNull()
  })

  test('reverting an estimated date calls it estimated again', async () => {
    const row = await addAsset({
      capturedAt: new Date('2019-07-04T11:22:33Z'),
      capturedAtIsExact: false,
    })

    const edited = await service.update(ownerId, row.id, {
      capturedAt: '1998-03-01T00:00:00.000Z',
    })
    expect(edited.capturedAtIsExact).toBe(true)

    const reverted = await service.update(ownerId, row.id, { resetCapturedAt: true })

    expect(reverted.capturedAtIsExact).toBe(false)
  })

  test('an unedited photo reports no original to fall back to', async () => {
    const row = await addAsset()
    const edited = await service.update(ownerId, row.id, { favorite: true })
    expect(edited.capturedAtOriginal).toBeNull()
  })
})
