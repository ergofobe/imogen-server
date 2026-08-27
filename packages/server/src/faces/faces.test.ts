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
import { createTestConfig, createTestDatabase, removeTestConfig } from '../test/harness.ts'
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

async function addFace(assetId: string, personId: string, faceOwnerId = ownerId) {
  await db.insert(faces).values({
    assetId,
    ownerId: faceOwnerId,
    personId,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    score: 0.9,
    embedding: Array(512).fill(0),
  })
}

async function seedOwner(): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email: `stranger-${randomUUID()}@example.com`, name: 'Stranger' })
    .returning()
  return row!.id
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
  })

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
