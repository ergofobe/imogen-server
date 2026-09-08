import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import type { Sharp } from 'sharp'
import sharp from 'sharp'
import type { Database } from '../db/index.ts'
import { assets, faces, people, users } from '../db/schema.ts'
import { COVER_SAMPLE } from '../lib/batch.ts'
import { createTestConfig, createTestDatabase, removeTestConfig } from '../test/harness.ts'
import { CLUSTER } from './cluster.ts'
import { FaceService } from './faces.ts'
import { ModelStore } from './models.ts'

const harness = await createTestDatabase()
const db: Database = harness.db
const config = createTestConfig()

/**
 * The models are 190 MB and are downloaded onto a server when someone enables the
 * feature, not committed here. A checkout without them skips these tests rather than
 * failing: everything they cover is exercised in CI once the fixtures exist locally.
 */
const FIXTURE_MODELS = join(
  process.env.IMOGEN_TEST_MODELS ?? join(process.env.HOME ?? '', '.cache/imogen-test-models'),
)
const store = new ModelStore(FIXTURE_MODELS)
const modelsPresent = await store.isReady()

/** Portraits of three different people, plus altered copies of each. */
const FACE_FIXTURES =
  process.env.IMOGEN_TEST_FACES ?? join(process.env.HOME ?? '', '.cache/imogen-test-faces')
const facesPresent = existsSync(join(FACE_FIXTURES, 'person-a.png'))

const canRun = modelsPresent && facesPresent

const queued: string[] = []
const service = new FaceService(
  db,
  store,
  (p) => join(config.libraryDir, p),
  async (name) => {
    queued.push(name)
  },
)

afterAll(async () => {
  await harness.close()
  removeTestConfig(config)
})

let ownerId: string

beforeAll(async () => {
  await mkdir(config.libraryDir, { recursive: true })
})

beforeEach(async () => {
  await db.execute(sql`truncate users, assets, faces, people, settings cascade`)
  const [user] = await db
    .insert(users)
    .values({ email: 'owner@example.com', name: 'Owner' })
    .returning()
  ownerId = user!.id
  await service.setEnabled(true)
})

let counter = 0

/** Copies a fixture into the library and registers it as an asset. */
async function addPhoto(
  fixture: string,
  transform?: (image: Sharp) => Sharp,
  overrides: Partial<typeof assets.$inferInsert> = {},
) {
  counter++
  const relative = `${ownerId}/${counter}.png`
  const absolute = join(config.libraryDir, relative)
  await mkdir(join(config.libraryDir, ownerId), { recursive: true })

  const base = sharp(join(FACE_FIXTURES, fixture))
  await (transform ? transform(base) : base).toFile(absolute)

  const [row] = await db
    .insert(assets)
    .values({
      ownerId,
      type: 'image',
      status: 'ready',
      originalFilename: `${counter}.png`,
      mimeType: 'image/png',
      checksum: counter.toString(16).padStart(64, '0'),
      sizeBytes: 1000,
      originalPath: relative,
      capturedAt: new Date(),
      ...overrides,
    })
    .returning()
  return row!
}

/** A bare asset row, for tests that exercise face bookkeeping without real detection. */
async function addBareAsset(overrides: Partial<typeof assets.$inferInsert> = {}) {
  counter++
  const [row] = await db
    .insert(assets)
    .values({
      ownerId,
      type: 'image',
      status: 'ready',
      originalFilename: `bare-${counter}.jpg`,
      mimeType: 'image/jpeg',
      checksum: counter.toString(16).padStart(64, '0'),
      sizeBytes: 1000,
      originalPath: `bare/${counter}.jpg`,
      capturedAt: new Date(),
      ...overrides,
    })
    .returning()
  return row!
}

async function addFace(assetId: string, personId: string, faceOwnerId = ownerId, score = 0.9) {
  const [row] = await db
    .insert(faces)
    .values({
      assetId,
      ownerId: faceOwnerId,
      personId,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      score,
      embedding: Array(512).fill(0),
    })
    .returning({ id: faces.id })
  return row!.id
}

async function seedOwner(): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email: `stranger-${randomUUID()}@example.com`, name: 'Stranger' })
    .returning()
  return row!.id
}

/** Builds one photo containing the given sitters, side by side. */
async function groupPhoto(fixtures: string[], name: string) {
  counter++
  const relative = `${ownerId}/${name}`
  await mkdir(join(config.libraryDir, ownerId), { recursive: true })

  const size = 640
  const tiles = await Promise.all(
    fixtures.map((f) =>
      sharp(join(FACE_FIXTURES, f)).resize(size, size, { fit: 'cover' }).toBuffer(),
    ),
  )
  await sharp({
    create: {
      width: size * fixtures.length + 40,
      height: size + 40,
      channels: 3,
      background: { r: 230, g: 228, b: 224 },
    },
  })
    .composite(tiles.map((input, i) => ({ input, left: 20 + i * size, top: 20 })))
    .jpeg({ quality: 92 })
    .toFile(join(config.libraryDir, relative))

  const [row] = await db
    .insert(assets)
    .values({
      ownerId,
      type: 'image',
      status: 'ready',
      originalFilename: name,
      mimeType: 'image/jpeg',
      checksum: counter.toString(16).padStart(64, '0'),
      sizeBytes: 5000,
      originalPath: relative,
      capturedAt: new Date(),
    })
    .returning()
  return row!
}

describe('forgetting a set of assets', () => {
  test('deletes every face for the listed assets, recounting exactly once', async () => {
    const [person] = await db.insert(people).values({ ownerId, name: 'Group' }).returning()
    const a = await addBareAsset()
    const b = await addBareAsset()
    await addFace(a.id, person!.id)
    await addFace(b.id, person!.id)
    const recounts = spyOn(service, 'refreshCounts')

    try {
      await service.forgetAssets([a.id, b.id], ownerId)

      expect(await db.select().from(faces)).toBeEmpty()
      // The person existed only in those photos, so recounting removes them too.
      expect(await db.select().from(people)).toBeEmpty()
      // Not once per asset — a selection can run to tens of thousands of them.
      expect(recounts).toHaveBeenCalledTimes(1)
    } finally {
      recounts.mockRestore()
    }
  })

  /**
   * Two PEOPLE alone would only prove `inArray(assetId, …)`. What actually closes the
   * pre-existing cross-tenant hole (the old `forgetAsset` deleted by asset id with no
   * owner scope at all) is `eq(faces.ownerId, ownerId)` — so this asks `forgetAssets` to
   * forget a stranger's asset id under the caller's own ownerId, and expects it to fail.
   */
  test('cannot forget another owner’s faces even when their asset id is named', async () => {
    const stranger = await seedOwner()
    const [strangerPerson] = await db
      .insert(people)
      .values({ ownerId: stranger, name: 'Stranger' })
      .returning()
    const strangerAsset = await addBareAsset({ ownerId: stranger })
    await addFace(strangerAsset.id, strangerPerson!.id, stranger)

    const [ownPerson] = await db.insert(people).values({ ownerId, name: 'Forgotten' }).returning()
    const ownAsset = await addBareAsset()
    await addFace(ownAsset.id, ownPerson!.id)

    await service.forgetAssets([ownAsset.id, strangerAsset.id], ownerId)

    const remaining = await db.select().from(faces)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.assetId).toBe(strangerAsset.id)
  })

  /**
   * `inArray(col, [])` renders as `false`, so the delete already matches nothing with or
   * without the early return — that alone would not catch its removal. An orphaned
   * person (zero faces, so `refreshCounts`'s cleanup step would delete them did it run)
   * survives only if the early return actually skipped calling it.
   */
  test('skips the database entirely for an empty list', async () => {
    const [orphan] = await db.insert(people).values({ ownerId, name: 'Orphan' }).returning()

    await service.forgetAssets([], ownerId)

    expect(await db.select().from(people).where(eq(people.id, orphan!.id))).toHaveLength(1)
  })
})

/**
 * Scanning one photograph can only change the people in that photograph, so recounting
 * the owner's entire library afterwards rewrites thousands of rows to the values they
 * already held. One production owner has 5,758 people and 28,320 assets: a backfill
 * meant 28,320 full rewrites of 5,758 rows apiece, every one of them under the
 * per-owner lock that #41 added, and every one leaving 5,758 dead tuples on a table
 * carrying an HNSW index.
 *
 * Naming the people to recount is what makes that proportional to the photograph. The
 * statements are otherwise untouched — same lock, same transaction, same visible-only
 * join — so the constraints below have to keep holding under the narrower scope, and
 * that is what these check.
 */
describe('recounting a named set of people', () => {
  test('leaves the owner’s other people completely alone', async () => {
    const asset = await addBareAsset()
    const [touched] = await db.insert(people).values({ ownerId, name: 'Touched' }).returning()
    // Deliberately wrong, and deliberately not in the scope: an unscoped recount
    // corrects it, which is exactly the 5,758-row rewrite being removed.
    const [bystander] = await db
      .insert(people)
      .values({ ownerId, name: 'Bystander', faceCount: 99 })
      .returning()
    await addFace(asset.id, touched!.id)

    await service.refreshCounts(ownerId, [touched!.id])

    const [after] = await db.select().from(people).where(eq(people.id, bystander!.id))
    expect(after?.faceCount).toBe(99)
    const [counted] = await db.select().from(people).where(eq(people.id, touched!.id))
    expect(counted?.faceCount).toBe(1)
  })

  test('still deletes a named person left with no visible faces', async () => {
    const [emptied] = await db.insert(people).values({ ownerId, name: 'Emptied' }).returning()
    const [kept] = await db.insert(people).values({ ownerId, name: 'Kept' }).returning()
    const asset = await addBareAsset()
    await addFace(asset.id, kept!.id)

    await service.refreshCounts(ownerId, [emptied!.id])

    expect(await db.select().from(people).where(eq(people.id, emptied!.id))).toBeEmpty()
    expect(await db.select().from(people).where(eq(people.id, kept!.id))).toHaveLength(1)
  })

  /**
   * An empty person outside the scope survives. Scanning a photograph is no longer the
   * thing that tidies up people it has nothing to do with — `refreshFor`, `forgetAssets`,
   * `mergePeople` and `reassignFaces` all still sweep the whole owner.
   */
  test('does not delete an empty person outside the scope', async () => {
    const [orphan] = await db.insert(people).values({ ownerId, name: 'Orphan' }).returning()
    const [named] = await db.insert(people).values({ ownerId, name: 'Named' }).returning()
    const asset = await addBareAsset()
    await addFace(asset.id, named!.id)

    await service.refreshCounts(ownerId, [named!.id])

    expect(await db.select().from(people).where(eq(people.id, orphan!.id))).toHaveLength(1)
  })

  test('counts no vaulted or trashed photo, and deletes a person left with only those', async () => {
    const visible = await addBareAsset()
    const vaulted = await addBareAsset({ vaultedAt: new Date() })
    const trashed = await addBareAsset({ deletedAt: new Date() })
    const [person] = await db.insert(people).values({ ownerId, name: 'Seen' }).returning()
    const [hidden] = await db.insert(people).values({ ownerId, name: 'Unseen' }).returning()
    await addFace(visible.id, person!.id)
    await addFace(vaulted.id, person!.id)
    await addFace(trashed.id, person!.id)
    await addFace(vaulted.id, hidden!.id)

    await service.refreshCounts(ownerId, [person!.id, hidden!.id])

    const [counted] = await db.select().from(people).where(eq(people.id, person!.id))
    expect(counted?.faceCount).toBe(1)
    // Every photograph they appeared in is gone from view, so they are too.
    expect(await db.select().from(people).where(eq(people.id, hidden!.id))).toBeEmpty()
  })

  /**
   * The cover is the highest-scoring face the owner can actually see. A better shot that
   * has been vaulted must not win it — that would put a vaulted photograph's crop on the
   * People page, which is the whole thing the vault is for.
   */
  test('covers with the highest-scoring visible face, not a better vaulted one', async () => {
    const visible = await addBareAsset()
    const vaulted = await addBareAsset({ vaultedAt: new Date() })
    const [person] = await db.insert(people).values({ ownerId, name: 'Covered' }).returning()
    await addFace(visible.id, person!.id, ownerId, 0.5)
    const best = await addFace(visible.id, person!.id, ownerId, 0.8)
    await addFace(vaulted.id, person!.id, ownerId, 0.99)

    await service.refreshCounts(ownerId, [person!.id])

    const [covered] = await db.select().from(people).where(eq(people.id, person!.id))
    expect(covered?.coverFaceId).toBe(best)
  })

  test('recounts every person the owner has when none are named', async () => {
    const asset = await addBareAsset()
    const [stale] = await db
      .insert(people)
      .values({ ownerId, name: 'Stale', faceCount: 99 })
      .returning()
    await addFace(asset.id, stale!.id)

    await service.refreshCounts(ownerId)

    const [after] = await db.select().from(people).where(eq(people.id, stale!.id))
    expect(after?.faceCount).toBe(1)
  })

  /**
   * `inArray(col, [])` renders as `false`, and an empty scope must mean "no people" rather
   * than quietly falling back to the whole owner — a scan that touched nobody would
   * otherwise still pay for the sweep it is meant to avoid.
   */
  test('touches nothing at all for an empty scope', async () => {
    const [orphan] = await db
      .insert(people)
      .values({ ownerId, name: 'Orphan', faceCount: 99 })
      .returning()

    await service.refreshCounts(ownerId, [])

    const [after] = await db.select().from(people).where(eq(people.id, orphan!.id))
    expect(after?.faceCount).toBe(99)
  })

  test('cannot recount another owner’s person even when their id is named', async () => {
    const stranger = await seedOwner()
    const [theirs] = await db
      .insert(people)
      .values({ ownerId: stranger, name: 'Stranger', faceCount: 99 })
      .returning()

    await service.refreshCounts(ownerId, [theirs!.id])

    const [after] = await db.select().from(people).where(eq(people.id, theirs!.id))
    expect(after?.faceCount).toBe(99)
  })
})

/**
 * Four job workers process one owner's photos at a time, and each finishes by recounting
 * that owner. Nothing serialised those recounts: the UPDATE and the DELETE inside
 * `refreshCounts` walk the same `people` rows, the grouped subquery fixes no order
 * between them, and concurrent copies took the same rows in different orders.
 *
 * In production this deadlocked continuously against one owner's 5,758 people — three
 * backends in a lock cycle, all running this same statement — and the retries piled up
 * until a statement hit the lock timeout and took the server down with it.
 *
 * Driven with plain rows rather than real detection, so it runs without the model
 * fixtures `canRun` gates.
 */
/**
 * `recordFace` files a face under a per-owner advisory lock, and says why: without it
 * concurrent workers each find nobody yet and split one person into three, and the
 * housekeeping pass can delete a person in the instant between creating them and
 * storing their face.
 *
 * `refreshCounts` performs that same housekeeping — it rewrites every one of the owner's
 * `people` rows and then deletes the empty ones — and took no lock at all. Against one
 * production owner's 5,758 people with four job workers, that gave three backends in a
 * lock cycle running this same UPDATE, a stream of `deadlock detected`, and
 * `faces_person_id_people_id_fk` violations from the DELETE landing between a person
 * being chosen and their face being inserted. Retries piled up until a statement hit the
 * 10s `lock_timeout` and took the server with it.
 *
 * Holding the lock elsewhere and watching the recount wait is the deterministic version
 * of that: a deadlock itself is a race, but "does not run concurrently" is not.
 */
describe('recounting under concurrency', () => {
  test('recounting waits for the same per-owner lock that files a face', async () => {
    const asset = await addBareAsset()
    const [person] = await db.insert(people).values({ ownerId }).returning()
    await addFace(asset.id, person!.id)

    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let locked!: () => void
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve
    })

    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`faces:${ownerId}`}))`)
      locked()
      await held
    })
    await isLocked

    let finished = false
    const recount = service.refreshCounts(ownerId).then(() => {
      finished = true
    })

    try {
      await Bun.sleep(250)
      // Unfixed, this has already run to completion straight through the lock.
      expect(finished).toBe(false)
    } finally {
      // Always let the holder commit: a failed assertion would otherwise leave the
      // transaction open and wedge the truncate in `beforeEach`.
      release()
      await holder
      await recount
    }

    expect(finished).toBe(true)
  })
})

/**
 * `photosOf` used to be `selectDistinctOn([assets.id])` with no `orderBy` at all — an
 * arbitrary five hundred in whatever order Postgres felt like handing back uuids, not
 * the most recent five hundred. Driven with plain `faces` rows rather than real
 * detection, so this runs without the model fixtures `canRun` gates.
 */
describe('the cover sample', () => {
  test("a person's sample is the most recent, not an arbitrary slice of uuid order", async () => {
    const [person] = await db.insert(people).values({ ownerId, name: 'Many' }).returning()
    const seeded = []
    for (let i = 0; i < COVER_SAMPLE + 40; i++) {
      const asset = await addBareAsset({ capturedAt: new Date(Date.now() - i * 1000) })
      await addFace(asset.id, person!.id)
      seeded.push(asset)
    }

    const photos = await service.photosOf(ownerId, person!.id)

    expect(photos).toHaveLength(COVER_SAMPLE)
    for (let i = 1; i < photos.length; i++) {
      expect(photos[i - 1]!.capturedAt.getTime()).toBeGreaterThanOrEqual(
        photos[i]!.capturedAt.getTime(),
      )
    }
    // The sample is the newest ones, not an arbitrary slice — seeded[0] is the newest.
    expect(photos[0]!.id).toBe(seeded[0]!.id)
  })

  /** The `id` half of `order by capturedAt desc, id desc` — never exercised by two
   * photographs a second apart, since `capturedAt` alone would already order them. */
  test('two photographs taken at the same instant break their tie on id, descending', async () => {
    const [person] = await db.insert(people).values({ ownerId, name: 'Tied' }).returning()
    const sharedTime = new Date()
    const a = await addBareAsset({ capturedAt: sharedTime })
    const b = await addBareAsset({ capturedAt: sharedTime })
    await addFace(a.id, person!.id)
    await addFace(b.id, person!.id)

    const photos = await service.photosOf(ownerId, person!.id)

    const expected = [a.id, b.id].sort((x, y) => (x > y ? -1 : x < y ? 1 : 0))
    expect(photos.map((p) => p.id)).toEqual(expected)
  })

  /**
   * A person can have more than one face in the same photograph (a mistaken split, a
   * photo of them in a mirror). `selectDistinctOn` must dedupe by photograph, not
   * return the join's one row per face.
   */
  test('a photograph with two faces of the same person is returned once', async () => {
    const [person] = await db.insert(people).values({ ownerId, name: 'Twice' }).returning()
    const asset = await addBareAsset()
    await addFace(asset.id, person!.id)
    await addFace(asset.id, person!.id)

    const photos = await service.photosOf(ownerId, person!.id)

    expect(photos.map((p) => p.id)).toEqual([asset.id])
  })
})

describe('a half-ingested asset', () => {
  /**
   * Three uploads on production were interrupted mid-ingest and left at `pending` with
   * an empty `original_path`. Detection took them anyway, handed sharp the empty path,
   * and each burned all five attempts on `Input file contains unsupported image format`.
   */
  test('an asset whose upload never finished is not scanned', async () => {
    const asset = await addBareAsset({ status: 'pending', originalPath: '' })

    expect(await service.processAsset(asset.id)).toBe(0)
    expect(await db.select().from(faces)).toBeEmpty()
  })

  test('and is left unscanned, so it is picked up once its upload completes', async () => {
    const asset = await addBareAsset({ status: 'pending', originalPath: '' })

    await service.processAsset(asset.id)

    const [row] = await db.select().from(assets).where(eq(assets.id, asset.id))
    expect(row!.facesScannedAt).toBeNull()
  })
})

describe.skipIf(!canRun)('detecting faces', () => {
  test('finds the face in a portrait', async () => {
    const asset = await addPhoto('person-a.png')

    const found = await service.processAsset(asset.id)

    expect(found).toBe(1)
    expect(await service.facesForAsset(ownerId, asset.id)).toHaveLength(1)
  })

  test('records where the face is, in the original’s pixels', async () => {
    const asset = await addPhoto('person-a.png')
    await service.processAsset(asset.id)

    const [face] = await service.facesForAsset(ownerId, asset.id)

    expect(face!.width).toBeGreaterThan(48)
    expect(face!.height).toBeGreaterThan(48)
    expect(face!.score).toBeGreaterThan(0.65)
  })

  /**
   * Face coordinates are drawn over the preview, which has EXIF orientation baked in.
   * If detection reads the stored frame instead of the upright one, the box lands
   * somewhere else — and on a quarter-turned photo it does not even fit the dimensions
   * the rest of the app reports.
   */
  test('a rotated photo’s coordinates fit the upright image', async () => {
    counter++
    const relative = `${ownerId}/rotated.jpg`
    await mkdir(join(config.libraryDir, ownerId), { recursive: true })
    // Orientation 6 means "turn a quarter clockwise to display".
    await sharp(join(FACE_FIXTURES, 'person-a.png'))
      .resize(900, 600, { fit: 'cover' })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toFile(join(config.libraryDir, relative))

    const [asset] = await db
      .insert(assets)
      .values({
        ownerId,
        type: 'image',
        status: 'ready',
        originalFilename: 'rotated.jpg',
        mimeType: 'image/jpeg',
        checksum: 'd'.repeat(64),
        sizeBytes: 5000,
        originalPath: relative,
        capturedAt: new Date(),
      })
      .returning()

    await service.processAsset(asset!.id)
    const [face] = await service.facesForAsset(ownerId, asset!.id)
    expect(face).toBeDefined()

    // Upright, the 900x600 photo displays as 600x900.
    expect(face!.x + face!.width).toBeLessThanOrEqual(600)
    expect(face!.y + face!.height).toBeLessThanOrEqual(900)
  })

  test('a photo with no faces is not scanned again on the next pass', async () => {
    counter++
    const relative = `${ownerId}/empty.png`
    await mkdir(join(config.libraryDir, ownerId), { recursive: true })
    await sharp({
      create: { width: 600, height: 400, channels: 3, background: { r: 30, g: 80, b: 50 } },
    })
      .png()
      .toFile(join(config.libraryDir, relative))
    const [asset] = await db
      .insert(assets)
      .values({
        ownerId,
        type: 'image',
        status: 'ready',
        originalFilename: 'empty.png',
        mimeType: 'image/png',
        checksum: 'e'.repeat(64),
        sizeBytes: 10,
        originalPath: relative,
        capturedAt: new Date(),
      })
      .returning()

    await service.processAsset(asset!.id)

    const [after] = await db.select().from(assets).where(eq(assets.id, asset!.id))
    expect(after!.facesScannedAt).not.toBeNull()
  })

  test('finds nothing in a photograph with no people in it', async () => {
    counter++
    const relative = `${ownerId}/landscape.png`
    await mkdir(join(config.libraryDir, ownerId), { recursive: true })
    await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 60, g: 110, b: 70 } },
    })
      .png()
      .toFile(join(config.libraryDir, relative))
    const [asset] = await db
      .insert(assets)
      .values({
        ownerId,
        type: 'image',
        status: 'ready',
        originalFilename: 'landscape.png',
        mimeType: 'image/png',
        checksum: 'a'.repeat(64),
        sizeBytes: 10,
        originalPath: relative,
        capturedAt: new Date(),
      })
      .returning()

    expect(await service.processAsset(asset!.id)).toBe(0)
  })

  test('does nothing at all while the feature is off', async () => {
    await service.setEnabled(false)
    const asset = await addPhoto('person-a.png')

    expect(await service.processAsset(asset.id)).toBe(0)
    expect(await db.select().from(faces)).toBeEmpty()
  })

  test('re-processing replaces a photo’s faces rather than duplicating them', async () => {
    const asset = await addPhoto('person-a.png')
    await service.processAsset(asset.id)
    await service.processAsset(asset.id)

    expect(await service.facesForAsset(ownerId, asset.id)).toHaveLength(1)
  })

  /**
   * "Replaces" has to hold when the replacement is nothing at all. The delete that clears
   * a photo's old faces sat below the `usable.length === 0` early return, so a scan that
   * found nobody left the previous scan's faces in place for ever — and an edited photo,
   * a tuned `minDetectionScore`, or an upgraded detector all reach exactly that path.
   * The faces then still counted toward their person and could still be that person's
   * cover, putting a crop of something no longer in the photograph on the People page.
   */
  test('a re-scan that now finds nobody clears the faces the last one found', async () => {
    const photo = await addPhoto('person-a.png')
    await service.processAsset(photo.id)
    expect(await service.facesForAsset(ownerId, photo.id)).toHaveLength(1)
    const [person] = await service.listPeople(ownerId)

    // The same asset, edited down to a plain green field.
    await sharp({
      create: { width: 600, height: 400, channels: 3, background: { r: 30, g: 80, b: 50 } },
    })
      .png()
      .toFile(join(config.libraryDir, photo.originalPath))

    expect(await service.processAsset(photo.id)).toBe(0)

    expect(await service.facesForAsset(ownerId, photo.id)).toBeEmpty()
    // They were only ever in that photograph, so the recount takes them with it — which
    // it can only do if the scan still recounts after finding nothing.
    expect(await db.select().from(people).where(eq(people.id, person!.id))).toBeEmpty()
  })

  /**
   * The people a scan recounts are collected *before* its faces are deleted, and this is
   * why. Re-scanning a photograph that now shows somebody else empties whoever used to be
   * in it, and nothing else in the pass will ever mention them again — collect the ids
   * afterwards and the emptied person is outside the scope, survives the cleanup, and
   * lingers in the People list with a face count they no longer have.
   */
  test('deletes a person whose only photograph no longer shows them', async () => {
    const photo = await addPhoto('person-a.png')
    await service.processAsset(photo.id)
    const before = await service.listPeople(ownerId)
    expect(before).toHaveLength(1)

    await sharp(join(FACE_FIXTURES, 'person-b.png')).toFile(
      join(config.libraryDir, photo.originalPath),
    )
    await service.processAsset(photo.id)

    const after = await service.listPeople(ownerId)
    expect(after).toHaveLength(1)
    expect(after[0]!.id).not.toBe(before[0]!.id)
  })
})

describe.skipIf(!canRun)('re-scanning a photograph that has confirmed faces', () => {
  test('a confirmed face survives a re-scan, refreshed in place', async () => {
    const photo = await addPhoto('person-a.png')
    await service.processAsset(photo.id)
    const [before] = await db.select().from(faces).where(eq(faces.assetId, photo.id))
    await db.update(faces).set({ confirmed: true, score: 0.01 }).where(eq(faces.id, before!.id))

    await service.processAsset(photo.id)

    const rows = await db.select().from(faces).where(eq(faces.assetId, photo.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(before!.id)
    expect(rows[0]!.personId).toBe(before!.personId)
    expect(rows[0]!.confirmed).toBe(true)
    // The stale 0.01 is gone — the refresh landed on this row rather than skipping it.
    expect(rows[0]!.score).toBeGreaterThanOrEqual(CLUSTER.minDetectionScore)
    const people1 = await service.listPeople(ownerId)
    expect(people1).toHaveLength(1)
    expect(people1[0]!.faceCount).toBe(1)
  })

  test('an unassigned confirmed face stays unassigned', async () => {
    const photo = await addPhoto('person-a.png')
    await service.processAsset(photo.id)
    const [before] = await db.select().from(faces).where(eq(faces.assetId, photo.id))
    // The real "this is nobody" path: it both clears personId and sets confirmed.
    await service.reassignFaces(ownerId, [before!.id], null)

    await service.processAsset(photo.id)

    const rows = await db.select().from(faces).where(eq(faces.assetId, photo.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(before!.id)
    expect(rows[0]!.personId).toBeNull()
    expect(rows[0]!.confirmed).toBe(true)
    // Not re-filed into a fresh person — an unassigned face stays unassigned.
    expect(await service.listPeople(ownerId)).toBeEmpty()
  })

  test('a confirmed face the detector no longer finds is left exactly as it is', async () => {
    const photo = await addPhoto('person-a.png')
    await service.processAsset(photo.id)
    const [before] = await db.select().from(faces).where(eq(faces.assetId, photo.id))
    await db.update(faces).set({ confirmed: true }).where(eq(faces.id, before!.id))

    // The same asset, edited down to a plain green field: the detector now finds nobody.
    await sharp({
      create: { width: 600, height: 400, channels: 3, background: { r: 30, g: 80, b: 50 } },
    })
      .png()
      .toFile(join(config.libraryDir, photo.originalPath))

    expect(await service.processAsset(photo.id)).toBe(0)

    const rows = await db.select().from(faces).where(eq(faces.assetId, photo.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(before!.id)
    expect(rows[0]!.personId).toBe(before!.personId)
    expect(rows[0]!.confirmed).toBe(true)
    expect(await service.listPeople(ownerId)).toHaveLength(1)
  })

  /**
   * Geometry is only the first way of recognising a confirmed face. Boxes recorded before
   * an orientation fix, or by a different detector, can miss the new detection entirely,
   * and leaving the row alone would then hand the fresh detection to `recordFace` — which
   * clusters it onto the same person, so one face becomes two rows, the confirmed one
   * pointing at the wrong pixels. When clustering agrees on the person, the human's row
   * adopts the new detection instead.
   */
  test('a confirmed face whose box has moved is adopted by its person’s next detection', async () => {
    const photo = await addPhoto('person-a.png')
    await service.processAsset(photo.id)
    const [before] = await db.select().from(faces).where(eq(faces.assetId, photo.id))
    await db.update(faces).set({ confirmed: true }).where(eq(faces.id, before!.id))

    // The same sitter, now far to the right of where the box says: no overlap at all.
    await sharp(join(FACE_FIXTURES, 'person-a.png'))
      .extend({ left: 800, background: '#fff' })
      .png()
      .toFile(join(config.libraryDir, photo.originalPath))

    expect(await service.processAsset(photo.id)).toBe(1)

    const rows = await db.select().from(faces).where(eq(faces.assetId, photo.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(before!.id)
    expect(rows[0]!.personId).toBe(before!.personId)
    expect(rows[0]!.confirmed).toBe(true)
    expect(rows[0]!.x).toBeGreaterThan(before!.x + 400)
    const people1 = await service.listPeople(ownerId)
    expect(people1).toHaveLength(1)
    expect(people1[0]!.faceCount).toBe(1)
  })

  test('a mixed photograph keeps its confirmed face and re-files the rest', async () => {
    const photo = await groupPhoto(['person-a.png', 'person-b.png', 'person-c.png'], 'mixed.jpg')
    expect(await service.processAsset(photo.id)).toBe(3)

    const before = await db.select().from(faces).where(eq(faces.assetId, photo.id))
    expect(before).toHaveLength(3)
    expect(await service.listPeople(ownerId)).toHaveLength(3)

    const confirmedRow = before[0]!
    await db.update(faces).set({ confirmed: true }).where(eq(faces.id, confirmedRow.id))

    expect(await service.processAsset(photo.id)).toBe(3)

    const after = await db.select().from(faces).where(eq(faces.assetId, photo.id))
    expect(after).toHaveLength(3)

    const survivor = after.find((f) => f.id === confirmedRow.id)
    expect(survivor?.personId).toBe(confirmedRow.personId)
    expect(survivor?.confirmed).toBe(true)

    // The other two were re-filed from scratch: new rows, matched back to their people.
    const others = after.filter((f) => f.id !== confirmedRow.id)
    expect(others).toHaveLength(2)
    expect(others.every((f) => !before.some((b) => b.id === f.id))).toBe(true)
    expect(await service.listPeople(ownerId)).toHaveLength(3)
  })
})

/**
 * Photographs that lost their faces before that fix landed still carry them, and nothing
 * re-scans a photograph whose `facesScannedAt` is stamped. Clearing that stamp to force a
 * re-scan is not the repair: it embeds and re-clusters every unconfirmed face on the
 * photograph, which is wasted work on a photograph that already has faces and would
 * needlessly re-group them.
 *
 * So the repair detects and stops. A photograph that still has faces is left exactly as
 * it is; only one that has genuinely lost them is touched.
 */
describe('re-checking a photograph for faces it has lost', () => {
  test('does nothing while the feature is off', async () => {
    await service.setEnabled(false)
    const asset = await addBareAsset()
    const [person] = await db.insert(people).values({ ownerId }).returning()
    await addFace(asset.id, person!.id)

    expect(await service.recheckAsset(asset.id)).toBe(false)
    expect(await db.select().from(faces)).toHaveLength(1)
  })

  test('never opens a vaulted photograph', async () => {
    const asset = await addBareAsset({ vaultedAt: new Date() })
    const [person] = await db.insert(people).values({ ownerId }).returning()
    await addFace(asset.id, person!.id)

    expect(await service.recheckAsset(asset.id)).toBe(false)
    expect(await db.select().from(faces)).toHaveLength(1)
  })

  test('never opens a trashed photograph', async () => {
    const asset = await addBareAsset({ deletedAt: new Date() })
    const [person] = await db.insert(people).values({ ownerId }).returning()
    await addFace(asset.id, person!.id)

    expect(await service.recheckAsset(asset.id)).toBe(false)
    expect(await db.select().from(faces)).toHaveLength(1)
  })
})

describe.skipIf(!canRun)('repairing a photograph that lost its faces', () => {
  test('removes the faces of a photograph that no longer shows anyone', async () => {
    const photo = await addPhoto('person-a.png')
    await service.processAsset(photo.id)
    const [person] = await service.listPeople(ownerId)

    // Exactly the state the bug left behind: faces on record, scanned, and an image that
    // no longer has anybody in it.
    await sharp({
      create: { width: 600, height: 400, channels: 3, background: { r: 30, g: 80, b: 50 } },
    })
      .png()
      .toFile(join(config.libraryDir, photo.originalPath))

    expect(await service.recheckAsset(photo.id)).toBe(true)

    expect(await service.facesForAsset(ownerId, photo.id)).toBeEmpty()
    expect(await db.select().from(people).where(eq(people.id, person!.id))).toBeEmpty()
  })

  /**
   * A photograph that still has faces is never written to by this pass — not because a
   * re-scan would discard them (it no longer does), but because detection alone already
   * answers the question this repair asks, and re-clustering is out of scope for it.
   */
  test('leaves a photograph that still has faces exactly as it found it', async () => {
    const photo = await addPhoto('person-a.png')
    await service.processAsset(photo.id)
    const [before] = await db.select().from(faces).where(eq(faces.assetId, photo.id))
    await db.update(faces).set({ confirmed: true }).where(eq(faces.id, before!.id))

    expect(await service.recheckAsset(photo.id)).toBe(false)

    const [after] = await db.select().from(faces).where(eq(faces.assetId, photo.id))
    // The same row, not a replacement wearing the same face.
    expect(after?.id).toBe(before!.id)
    expect(after?.personId).toBe(before!.personId)
    expect(after?.confirmed).toBe(true)
  })

  /**
   * `processAsset` now spares confirmed faces on its own, but `recheckAsset` only ever
   * clears an asset when detection finds nobody at all — so this is the one case where
   * a confirmed face's survival depends on `clearFaces` filtering by `confirmed` rather
   * than on a re-scan never reaching it.
   */
  test('spares a confirmed face when it finds nobody', async () => {
    const photo = await addPhoto('person-a.png')
    await service.processAsset(photo.id)
    const [before] = await db.select().from(faces).where(eq(faces.assetId, photo.id))
    await db.update(faces).set({ confirmed: true }).where(eq(faces.id, before!.id))

    await sharp({
      create: { width: 600, height: 400, channels: 3, background: { r: 30, g: 80, b: 50 } },
    })
      .png()
      .toFile(join(config.libraryDir, photo.originalPath))

    expect(await service.recheckAsset(photo.id)).toBe(false)

    const [after] = await db.select().from(faces).where(eq(faces.assetId, photo.id))
    expect(after?.id).toBe(before!.id)
    expect(after?.personId).toBe(before!.personId)
    expect(after?.confirmed).toBe(true)
    expect(await service.listPeople(ownerId)).toHaveLength(1)
  })

  test('reports nothing repaired for a photograph that had no faces anyway', async () => {
    const photo = await addPhoto('person-a.png')
    await sharp({
      create: { width: 600, height: 400, channels: 3, background: { r: 30, g: 80, b: 50 } },
    })
      .png()
      .toFile(join(config.libraryDir, photo.originalPath))

    expect(await service.recheckAsset(photo.id)).toBe(false)
  })
})

describe.skipIf(!canRun)('grouping faces into people', () => {
  test('groups the same person photographed differently', async () => {
    const a = await addPhoto('person-a.png')
    const b = await addPhoto('person-a.png', (i) => i.modulate({ brightness: 1.3 }))
    const c = await addPhoto('person-a.png', (i) => i.rotate(8, { background: '#fff' }))

    for (const asset of [a, b, c]) await service.processAsset(asset.id)

    const found = await service.listPeople(ownerId)
    expect(found).toHaveLength(1)
    expect(found[0]!.faceCount).toBe(3)
  })

  test('keeps different people apart', async () => {
    for (const fixture of ['person-a.png', 'person-b.png', 'person-c.png']) {
      const asset = await addPhoto(fixture)
      await service.processAsset(asset.id)
    }

    expect(await service.listPeople(ownerId)).toHaveLength(3)
  })

  /** The mistake worth guarding: two people collapsing into one. */
  test('never merges two different people automatically', async () => {
    const shots = ['person-a.png', 'person-a.png', 'person-b.png', 'person-b.png', 'person-c.png']
    for (const fixture of shots) {
      const asset = await addPhoto(fixture, (i) =>
        i.modulate({ brightness: 0.9 + Math.random() * 0.2 }),
      )
      await service.processAsset(asset.id)
    }

    const found = await service.listPeople(ownerId)
    expect(found.length).toBeGreaterThanOrEqual(3)
    // Nobody should have collected faces belonging to two different sitters.
    expect(found.every((p) => p.faceCount <= 2)).toBe(true)
  })

  /**
   * The job queue scans several photos at once. Before the assignment was serialised,
   * four workers each looked for an existing person, each found none yet, and each
   * created one — so three photographs of one face became three different people.
   */
  test('stays one person when several photos are scanned at the same time', async () => {
    // Added one at a time, then scanned all at once — the race is in the scanning.
    const shots = [
      await addPhoto('person-a.png'),
      await addPhoto('person-a.png', (i) => i.modulate({ brightness: 1.2 })),
      await addPhoto('person-a.png', (i) => i.modulate({ brightness: 0.8 })),
      await addPhoto('person-a.png', (i) => i.rotate(6, { background: '#fff' })),
    ]

    await Promise.all(shots.map((asset) => service.processAsset(asset.id)))

    const found = await service.listPeople(ownerId)
    expect(found).toHaveLength(1)
    expect(found[0]!.faceCount).toBe(4)
  })

  /**
   * The housekeeping pass removes people who have no visible photos. Before assignment
   * and storage were atomic, it could remove a person in the moment between their being
   * created and their first face being written — leaving that face attached to nobody.
   */
  test('every stored face belongs to somebody', async () => {
    const shots = [
      await addPhoto('person-a.png'),
      await addPhoto('person-b.png'),
      await addPhoto('person-c.png'),
      await addPhoto('person-a.png', (i) => i.modulate({ brightness: 1.2 })),
      await addPhoto('person-b.png', (i) => i.modulate({ brightness: 0.8 })),
    ]

    await Promise.all(shots.map((asset) => service.processAsset(asset.id)))

    const stored = await db.select().from(faces)
    expect(stored.length).toBeGreaterThan(0)
    expect(stored.every((f) => f.personId !== null)).toBe(true)
    // Five photographs through the ONNX pipeline at once fits in bun's default 5s only
    // on an idle machine; a loaded runner has taken 5.6s, and timing out here leaves
    // rows behind that fail the next test's truncate instead of just this one.
  }, 15_000)

  test('lists the photos a person appears in', async () => {
    const a = await addPhoto('person-a.png')
    const b = await addPhoto('person-a.png', (i) => i.modulate({ brightness: 1.2 }))
    for (const asset of [a, b]) await service.processAsset(asset.id)

    const [person] = await service.listPeople(ownerId)
    const photos = await service.photosOf(ownerId, person!.id)

    expect(photos.map((p) => p.id).sort()).toEqual([a.id, b.id].sort())
  })
})

describe.skipIf(!canRun)('photos with several people in them', () => {
  test('finds every face in the photo', async () => {
    const photo = await groupPhoto(['person-a.png', 'person-b.png', 'person-c.png'], 'group.jpg')

    expect(await service.processAsset(photo.id)).toBe(3)
    expect(await service.facesForAsset(ownerId, photo.id)).toHaveLength(3)
  })

  test('gives each face to a different person', async () => {
    const photo = await groupPhoto(['person-a.png', 'person-b.png', 'person-c.png'], 'group.jpg')
    await service.processAsset(photo.id)

    const found = await service.facesForAsset(ownerId, photo.id)
    const owners = new Set(found.map((f) => f.personId))
    expect(owners.size).toBe(3)
  })

  test('joins people already known from their own portraits', async () => {
    const alone = await addPhoto('person-a.png')
    await service.processAsset(alone.id)
    const before = await service.listPeople(ownerId)
    expect(before).toHaveLength(1)

    const photo = await groupPhoto(['person-a.png', 'person-b.png'], 'together.jpg')
    await service.processAsset(photo.id)

    // Anna is recognised rather than re-invented; only her companion is new.
    const after = await service.listPeople(ownerId)
    expect(after).toHaveLength(2)
    const anna = after.find((p) => p.id === before[0]!.id)
    expect(anna?.faceCount).toBe(2)
  })

  test('a group photo appears once in each person’s photos, not once per face', async () => {
    const photo = await groupPhoto(['person-a.png', 'person-b.png'], 'together.jpg')
    await service.processAsset(photo.id)

    for (const person of await service.listPeople(ownerId)) {
      const photos = await service.photosOf(ownerId, person.id)
      expect(photos.map((p) => p.id)).toEqual([photo.id])
    }
  })

  test('every face in a group photo belongs to somebody', async () => {
    const photo = await groupPhoto(['person-a.png', 'person-b.png', 'person-c.png'], 'group.jpg')
    await service.processAsset(photo.id)

    const stored = await db.select().from(faces)
    expect(stored).toHaveLength(3)
    expect(stored.every((f) => f.personId !== null)).toBe(true)
  })

  /**
   * The `forgetAssets` counterpart of this ("recounting exactly once") exists because a
   * selection can run to tens of thousands of assets. This one exists because a *library*
   * can run to thousands of people: recounting all of them after each photograph is what
   * made a 28,320-asset backfill rewrite 5,758 rows 28,320 times over.
   */
  test('recounts the people in the photograph, not the whole library', async () => {
    const [bystander] = await db
      .insert(people)
      .values({ ownerId, name: 'Bystander', faceCount: 99 })
      .returning()
    const photo = await groupPhoto(['person-a.png', 'person-b.png'], 'together.jpg')
    const recounts = spyOn(service, 'refreshCounts')

    try {
      await service.processAsset(photo.id)

      expect(recounts).toHaveBeenCalledTimes(1)
      expect(recounts.mock.calls[0]![1]).toHaveLength(2)
      // Nobody in this photograph, so its recount does not rewrite them.
      const [after] = await db.select().from(people).where(eq(people.id, bystander!.id))
      expect(after?.faceCount).toBe(99)
    } finally {
      recounts.mockRestore()
    }
  })

  test('vaulting a group photo removes it from everybody', async () => {
    const alone = await addPhoto('person-a.png')
    await service.processAsset(alone.id)
    const photo = await groupPhoto(['person-a.png', 'person-b.png'], 'together.jpg')
    await service.processAsset(photo.id)

    await db.update(assets).set({ vaultedAt: new Date() }).where(eq(assets.id, photo.id))
    await service.forgetAssets([photo.id], ownerId)

    // Anna keeps her own portrait; her companion, seen only there, is gone.
    const after = await service.listPeople(ownerId)
    expect(after).toHaveLength(1)
    expect(after[0]!.faceCount).toBe(1)
  })
})

describe.skipIf(!canRun)('correcting the grouping', () => {
  async function twoPeople() {
    const a = await addPhoto('person-a.png')
    const b = await addPhoto('person-b.png')
    for (const asset of [a, b]) await service.processAsset(asset.id)
    return service.listPeople(ownerId)
  }

  test('names a person', async () => {
    const [person] = await twoPeople()

    await service.renamePerson(ownerId, person!.id, 'Anna')

    expect((await service.getPerson(ownerId, person!.id)).name).toBe('Anna')
  })

  test('merges two clusters that were the same person after all', async () => {
    const found = await twoPeople()

    const moved = await service.mergePeople(ownerId, found[0]!.id, [found[1]!.id])

    expect(moved).toBe(1)
    expect(await service.listPeople(ownerId)).toHaveLength(1)
  })

  test('hides a person without losing the grouping', async () => {
    const [person] = await twoPeople()

    await service.setHidden(ownerId, person!.id, true)

    expect((await service.listPeople(ownerId)).map((p) => p.id)).not.toContain(person!.id)
    expect((await service.listPeople(ownerId, true)).map((p) => p.id)).toContain(person!.id)
  })

  test('one account cannot touch another’s people', async () => {
    const [person] = await twoPeople()
    const [other] = await db
      .insert(users)
      .values({ email: 'other@example.com', name: 'Other' })
      .returning()

    await expect(service.renamePerson(other!.id, person!.id, 'Mine')).rejects.toThrow()
  })
})

describe.skipIf(!canRun)('the vault is out of reach', () => {
  test('a vaulted photo is never scanned', async () => {
    const asset = await addPhoto('person-a.png', undefined, { vaultedAt: new Date() })

    expect(await service.processAsset(asset.id)).toBe(0)
    expect(await db.select().from(faces)).toBeEmpty()
  })

  test('vaulting a photo forgets the faces already found in it', async () => {
    const asset = await addPhoto('person-a.png')
    await service.processAsset(asset.id)
    expect(await db.select().from(faces)).toHaveLength(1)

    await db.update(assets).set({ vaultedAt: new Date() }).where(eq(assets.id, asset.id))
    await service.forgetAssets([asset.id], ownerId)

    expect(await db.select().from(faces)).toBeEmpty()
    expect(await service.listPeople(ownerId)).toBeEmpty()
  })

  test('a person’s photos never include a vaulted one', async () => {
    const shown = await addPhoto('person-a.png')
    const hidden = await addPhoto('person-a.png', (i) => i.modulate({ brightness: 1.2 }))
    for (const asset of [shown, hidden]) await service.processAsset(asset.id)

    await db.update(assets).set({ vaultedAt: new Date() }).where(eq(assets.id, hidden.id))

    const [person] = await service.listPeople(ownerId)
    const photos = await service.photosOf(ownerId, person!.id)

    expect(photos.map((p) => p.id)).toEqual([shown.id])
  })

  test('a person who exists only in vaulted photos stops existing', async () => {
    const asset = await addPhoto('person-a.png')
    await service.processAsset(asset.id)

    await db.update(assets).set({ vaultedAt: new Date() }).where(eq(assets.id, asset.id))
    await service.forgetAssets([asset.id], ownerId)

    expect(await db.select().from(people)).toBeEmpty()
  })
})

describe.skipIf(!canRun)('searching by name', () => {
  test('finds a named person', async () => {
    const asset = await addPhoto('person-a.png')
    await service.processAsset(asset.id)
    const [person] = await service.listPeople(ownerId)
    await service.renamePerson(ownerId, person!.id, 'Anna Kowalski')

    expect((await service.findPeopleByName(ownerId, 'anna')).map((p) => p.name)).toEqual([
      'Anna Kowalski',
    ])
  })

  test('does not offer unnamed or hidden people', async () => {
    const asset = await addPhoto('person-a.png')
    await service.processAsset(asset.id)
    const [person] = await service.listPeople(ownerId)

    expect(await service.findPeopleByName(ownerId, '')).toBeEmpty()

    await service.renamePerson(ownerId, person!.id, 'Anna')
    await service.setHidden(ownerId, person!.id, true)
    expect(await service.findPeopleByName(ownerId, 'anna')).toBeEmpty()
  })
})
