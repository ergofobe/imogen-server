import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq, inArray, sql } from 'drizzle-orm'
import sharp from 'sharp'
import type { Database } from '../db/index.ts'
import { assets, jobs, settings, users } from '../db/schema.ts'
import { LocalStorage } from '../media/storage.ts'
import { createTestConfig, createTestDatabase, removeTestConfig } from '../test/harness.ts'
import { JobQueue } from './queue.ts'
import {
  CAPTURE_TIME_REPAIR_JOB,
  countRepairCandidates,
  ORIENTATION_REPAIR_JOB,
  REPAIR_BATCH,
  registerRepairJobs,
  repairAsset,
} from './repair.ts'

const harness = await createTestDatabase()
const db: Database = harness.db
const config = createTestConfig()
const storage = new LocalStorage(config.libraryDir)

afterAll(async () => {
  await harness.close()
  removeTestConfig(config)
})

beforeEach(async () => {
  await db.execute(sql`truncate jobs, users, assets, settings cascade`)
})

function setup() {
  const queue = new JobQueue(db, { concurrency: 1, idlePollMs: 5 })
  registerRepairJobs(queue, { db, storage, queue })
  return queue
}

/** Distinct pixels per seed so two fixtures never share a checksum. */
function canvas(seed: string) {
  const n = [...seed].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 251, 7)
  return sharp({
    create: { width: 24, height: 16, channels: 3, background: { r: n, g: (n * 3) % 256, b: 11 } },
  })
}

type Fixture = {
  /** `2026:08:04 16:52:52` and friends, or null for a file with no capture time at all. */
  capturedAt?: string | null
  /** `+09:00`, or null for the zone-less wall clock #50 could not place. */
  offset?: string | null
  orientation?: number | null
}

/** Writes a JPEG into the library and returns its path relative to the library root. */
async function writeJpeg(seed: string, fixture: Fixture = {}): Promise<string> {
  const exif: Record<string, Record<string, string>> = {}
  if (fixture.capturedAt) {
    exif.IFD2 = {
      DateTimeOriginal: fixture.capturedAt,
      ...(fixture.offset ? { OffsetTimeOriginal: fixture.offset } : {}),
    }
  }
  let image = canvas(seed)
  // `withMetadata` is the only way to set Orientation: sharp normalises the IFD0 tag away
  // when it is written through `exif`, because it has already applied it to the pixels.
  if (fixture.orientation || Object.keys(exif).length > 0) {
    image = image.withMetadata({
      ...(fixture.orientation ? { orientation: fixture.orientation } : {}),
      ...(Object.keys(exif).length > 0 ? { exif } : {}),
    })
  }

  const path = `${crypto.randomUUID()}.jpg`
  await storage.write(path, await image.jpeg().toBuffer())
  return path
}

describe('repairing library rows written before ingest read the file correctly', () => {
  let ownerId: string

  beforeEach(async () => {
    const [user] = await db
      .insert(users)
      .values({ email: 'owner@example.com', name: 'Owner' })
      .returning()
    ownerId = user!.id
  })

  async function insertAsset(overrides: Partial<typeof assets.$inferInsert> = {}) {
    const n = crypto.randomUUID()
    const [asset] = await db
      .insert(assets)
      .values({
        ownerId,
        type: 'image',
        status: 'ready',
        originalFilename: `${n}.jpg`,
        mimeType: 'image/jpeg',
        checksum: n.replaceAll('-', '').padEnd(64, '0'),
        sizeBytes: 1000,
        originalPath: `${n}.jpg`,
        capturedAt: new Date('2026-08-04T16:52:52.000Z'),
        ...overrides,
      })
      .returning()
    return asset!
  }

  const read = async (id: string) => {
    const [row] = await db.select().from(assets).where(eq(assets.id, id))
    return row!
  }

  const doneKey = async (key: string) => {
    const [row] = await db.select().from(settings).where(eq(settings.key, key))
    return row
  }

  describe('the capture time stored before the EXIF offset was read (#54)', () => {
    test('re-derives the instant for a file that carries its offset', async () => {
      const queue = setup()
      const path = await writeJpeg('offset', {
        capturedAt: '2026:08:04 16:52:52',
        offset: '+09:00',
      })
      // What ingest stored: the wall clock read as UTC, nine hours late.
      const asset = await insertAsset({
        originalPath: path,
        capturedAt: new Date('2026-08-04T16:52:52.000Z'),
        capturedAtIsExact: true,
      })

      await queue.enqueue(CAPTURE_TIME_REPAIR_JOB, {})
      await queue.drain()

      const row = await read(asset.id)
      expect(row.capturedAt.toISOString()).toBe('2026-08-04T07:52:52.000Z')
      expect(row.capturedAtIsExact).toBe(true)
      expect(await doneKey('repair.captureTimeDone')).toBeDefined()
    })

    /**
     * The row that matters. An owner who corrected the date by hand has made a decision
     * the file cannot overrule, and there is no way back from overwriting it.
     */
    test('never touches a row an owner has already corrected, whatever its file says', async () => {
      const queue = setup()
      const path = await writeJpeg('corrected', {
        capturedAt: '2026:08:04 16:52:52',
        offset: '+09:00',
      })
      const corrected = new Date('1999-01-01T00:00:00.000Z')
      const asset = await insertAsset({
        originalPath: path,
        capturedAt: corrected,
        capturedAtIsExact: true,
        capturedAtOriginal: new Date('2026-08-04T16:52:52.000Z'),
        capturedAtOriginalIsExact: true,
      })

      await queue.enqueue(CAPTURE_TIME_REPAIR_JOB, {})
      await queue.drain()

      const row = await read(asset.id)
      expect(row.capturedAt.toISOString()).toBe(corrected.toISOString())
      expect(row.updatedAt.toISOString()).toBe(asset.updatedAt.toISOString())
    })

    /**
     * Nothing in the file can place this one, and the client's own timestamp is gone, so
     * the stored wall-clock-as-UTC reading is already the best answer available. Writing
     * it again would be churn dressed as repair.
     */
    test('leaves a file whose EXIF carries no offset exactly where it is', async () => {
      const queue = setup()
      const path = await writeJpeg('no-offset', { capturedAt: '2026:08:04 16:52:52' })
      const asset = await insertAsset({
        originalPath: path,
        capturedAt: new Date('2026-08-04T16:52:52.000Z'),
        capturedAtIsExact: true,
      })

      await queue.enqueue(CAPTURE_TIME_REPAIR_JOB, {})
      await queue.drain()

      const row = await read(asset.id)
      expect(row.capturedAt.toISOString()).toBe('2026-08-04T16:52:52.000Z')
      expect(row.updatedAt.toISOString()).toBe(asset.updatedAt.toISOString())
    })

    test('leaves a file with no capture time at all alone', async () => {
      const queue = setup()
      const path = await writeJpeg('bare')
      const asset = await insertAsset({ originalPath: path, capturedAtIsExact: true })

      await queue.enqueue(CAPTURE_TIME_REPAIR_JOB, {})
      await queue.drain()

      expect((await read(asset.id)).updatedAt.toISOString()).toBe(asset.updatedAt.toISOString())
    })

    /** Their pre-fix value came from ffprobe, and nothing in the container can settle it. */
    test('leaves videos out of the walk entirely', async () => {
      const queue = setup()
      const path = await writeJpeg('video', {
        capturedAt: '2026:08:04 16:52:52',
        offset: '+09:00',
      })
      const asset = await insertAsset({
        originalPath: path,
        type: 'video',
        mimeType: 'video/mp4',
        capturedAtIsExact: true,
      })

      await queue.enqueue(CAPTURE_TIME_REPAIR_JOB, {})
      await queue.drain()

      expect((await read(asset.id)).updatedAt.toISOString()).toBe(asset.updatedAt.toISOString())
    })

    test('running it a second time writes nothing', async () => {
      const queue = setup()
      const path = await writeJpeg('twice', {
        capturedAt: '2026:08:04 16:52:52',
        offset: '+09:00',
      })
      const asset = await insertAsset({
        originalPath: path,
        capturedAt: new Date('2026-08-04T16:52:52.000Z'),
        capturedAtIsExact: true,
      })

      await queue.enqueue(CAPTURE_TIME_REPAIR_JOB, {})
      await queue.drain()
      const first = await read(asset.id)

      await queue.enqueue(CAPTURE_TIME_REPAIR_JOB, {})
      await queue.drain()
      const second = await read(asset.id)

      expect(second.capturedAt.toISOString()).toBe(first.capturedAt.toISOString())
      expect(second.updatedAt.toISOString()).toBe(first.updatedAt.toISOString())
    })

    test('a file that is missing on disk does not take the pass down with it', async () => {
      const queue = setup()
      const asset = await insertAsset({ capturedAtIsExact: true })

      await queue.enqueue(CAPTURE_TIME_REPAIR_JOB, {})
      await queue.drain()

      expect((await read(asset.id)).updatedAt.toISOString()).toBe(asset.updatedAt.toISOString())
      expect(await db.select().from(jobs).where(eq(jobs.status, 'failed'))).toEqual([])
      expect(await doneKey('repair.captureTimeDone')).toBeDefined()
    })

    test('walks past a full batch by re-enqueueing itself', async () => {
      const queue = setup()
      const ids: string[] = []
      for (let i = 0; i <= REPAIR_BATCH; i++) {
        const path = await writeJpeg(`batch-${i}`, {
          capturedAt: '2026:08:04 16:52:52',
          offset: '+09:00',
        })
        const asset = await insertAsset({
          originalPath: path,
          capturedAt: new Date('2026-08-04T16:52:52.000Z'),
          capturedAtIsExact: true,
        })
        ids.push(asset.id)
      }

      await queue.enqueue(CAPTURE_TIME_REPAIR_JOB, {})
      await queue.drain()

      const rows = await db.select().from(assets).where(inArray(assets.id, ids))
      expect(rows).toHaveLength(REPAIR_BATCH + 1)
      for (const row of rows) {
        expect(row.capturedAt.toISOString()).toBe('2026-08-04T07:52:52.000Z')
      }

      const runs = await db.select().from(jobs).where(eq(jobs.name, CAPTURE_TIME_REPAIR_JOB))
      expect(runs.length).toBeGreaterThan(1)
    })

    test('counts the rows the pass will examine', async () => {
      await insertAsset({ capturedAtIsExact: true })
      // Opened too: the old reader wrote this flag, so `false` does not mean the file has
      // nothing to say. See the widened predicate.
      await insertAsset({ capturedAtIsExact: false })
      await insertAsset({ capturedAtIsExact: true, capturedAtOriginal: new Date() })
      await insertAsset({ capturedAtIsExact: true, type: 'video', mimeType: 'video/mp4' })

      expect(await countRepairCandidates(db, 'captureTime')).toBe(2)
    })
  })

  /**
   * `captured_at_is_exact` was written by the old reader, so `false` means "that reader
   * could not parse the date tag", not "the file has nothing to say". Those rows fell
   * through to a client timestamp or a file mtime and are the worst-dated in the library,
   * so the walk opens them — and the same leave-alone standard applies to them as to any
   * other row it opens.
   */
  describe('rows the old reader gave up on', () => {
    test('repairs one whose file names an instant with an offset, flag and all', async () => {
      const queue = setup()
      const path = await writeJpeg('inexact', {
        capturedAt: '2026:08:04 16:52:52',
        offset: '+09:00',
      })
      // Dated by the file mtime, because the old reader made nothing of the date tag.
      const asset = await insertAsset({
        originalPath: path,
        capturedAt: new Date('2026-09-01T12:00:00.000Z'),
        capturedAtIsExact: false,
      })

      await queue.enqueue(CAPTURE_TIME_REPAIR_JOB, {})
      await queue.drain()

      const row = await read(asset.id)
      expect(row.capturedAt.toISOString()).toBe('2026-08-04T07:52:52.000Z')
      expect(row.capturedAtIsExact).toBe(true)
    })

    test('leaves one whose file still names no offset entirely alone', async () => {
      const queue = setup()
      const path = await writeJpeg('inexact-no-offset', { capturedAt: '2026:08:04 16:52:52' })
      const asset = await insertAsset({
        originalPath: path,
        capturedAt: new Date('2026-09-01T12:00:00.000Z'),
        capturedAtIsExact: false,
      })

      await queue.enqueue(CAPTURE_TIME_REPAIR_JOB, {})
      await queue.drain()

      const row = await read(asset.id)
      expect(row.capturedAt.toISOString()).toBe('2026-09-01T12:00:00.000Z')
      expect(row.capturedAtIsExact).toBe(false)
      expect(row.updatedAt.toISOString()).toBe(asset.updatedAt.toISOString())
    })

    /**
     * A client timestamp can already be the right instant while the label says otherwise.
     * Testing the instant alone would leave the row holding an exact value flagged inexact.
     */
    test('puts the label right when the instant already matches', async () => {
      const queue = setup()
      const path = await writeJpeg('inexact-right-instant', {
        capturedAt: '2026:08:04 16:52:52',
        offset: '+09:00',
      })
      const asset = await insertAsset({
        originalPath: path,
        capturedAt: new Date('2026-08-04T07:52:52.000Z'),
        capturedAtIsExact: false,
        capturedAtFromClient: true,
      })

      await queue.enqueue(CAPTURE_TIME_REPAIR_JOB, {})
      await queue.drain()

      const row = await read(asset.id)
      expect(row.capturedAt.toISOString()).toBe('2026-08-04T07:52:52.000Z')
      expect(row.capturedAtIsExact).toBe(true)
    })
  })

  /**
   * A batch names twenty-five ids up front and then opens each file in turn, so seconds
   * pass between a row being chosen and being written. Everything the passes promise never
   * to touch has to survive being corrected inside that window, which means the guard has
   * to be on the write and not only on the query that picked the row.
   *
   * Expressed by repairing one asset directly, which is the same thing without having to
   * race the queue: the row was a candidate when the batch was built and is not one by the
   * time its turn comes.
   */
  describe('a row that leaves the candidate set while the batch is in flight', () => {
    test('is not overwritten when an owner corrects the date first', async () => {
      const path = await writeJpeg('raced', { capturedAt: '2026:08:04 16:52:52', offset: '+09:00' })
      const asset = await insertAsset({
        originalPath: path,
        capturedAt: new Date('2026-08-04T16:52:52.000Z'),
        capturedAtIsExact: true,
      })

      const corrected = new Date('1999-01-01T00:00:00.000Z')
      await db
        .update(assets)
        .set({ capturedAt: corrected, capturedAtOriginal: new Date('2026-08-04T16:52:52.000Z') })
        .where(eq(assets.id, asset.id))

      await repairAsset({ db, storage, queue: setup() }, asset.id, 'captureTime')

      expect((await read(asset.id)).capturedAt.toISOString()).toBe(corrected.toISOString())
    })

    test('is not rewritten when its orientation has since been filled in', async () => {
      const path = await writeJpeg('raced-orientation', { orientation: 6 })
      const asset = await insertAsset({ originalPath: path, exif: { orientation: null } })

      await db
        .update(assets)
        .set({ exif: { orientation: 1 } })
        .where(eq(assets.id, asset.id))

      await repairAsset({ db, storage, queue: setup() }, asset.id, 'exifOrientation')

      expect((await read(asset.id)).exif).toMatchObject({ orientation: 1 })
    })
  })

  describe('exif.orientation for assets ingested before the tag was read (#57)', () => {
    test('fills in the orientation the file has carried all along', async () => {
      const queue = setup()
      const path = await writeJpeg('rotated', { orientation: 6 })
      const asset = await insertAsset({
        originalPath: path,
        exif: { make: 'Apple', model: 'iPhone 11', orientation: null },
      })

      await queue.enqueue(ORIENTATION_REPAIR_JOB, {})
      await queue.drain()

      const row = await read(asset.id)
      expect(row.exif).toMatchObject({ make: 'Apple', model: 'iPhone 11', orientation: 6 })
      expect(await doneKey('repair.exifOrientationDone')).toBeDefined()
    })

    test('fills the whole shape in when the row had no exif object at all', async () => {
      const queue = setup()
      const path = await writeJpeg('no-exif-row', { orientation: 3 })
      const asset = await insertAsset({ originalPath: path, exif: null })

      await queue.enqueue(ORIENTATION_REPAIR_JOB, {})
      await queue.drain()

      // A client decodes this against `ExifData`, which wants every key present.
      expect(await read(asset.id).then((row) => row.exif)).toEqual({
        make: null,
        model: null,
        lens: null,
        fNumber: null,
        exposureTime: null,
        iso: null,
        focalLength: null,
        orientation: 3,
      })
    })

    test('leaves a row alone when the file carries no EXIF to re-read', async () => {
      const queue = setup()
      const path = await writeJpeg('unoriented')
      const asset = await insertAsset({
        originalPath: path,
        exif: { make: 'TestCam', orientation: null },
      })

      await queue.enqueue(ORIENTATION_REPAIR_JOB, {})
      await queue.drain()

      const row = await read(asset.id)
      expect(row.exif).toMatchObject({ orientation: null })
      expect(row.updatedAt.toISOString()).toBe(asset.updatedAt.toISOString())
    })

    test('never revisits a row that already has one', async () => {
      const queue = setup()
      const path = await writeJpeg('already', { orientation: 8 })
      const asset = await insertAsset({ originalPath: path, exif: { orientation: 1 } })

      await queue.enqueue(ORIENTATION_REPAIR_JOB, {})
      await queue.drain()

      const row = await read(asset.id)
      expect(row.exif).toMatchObject({ orientation: 1 })
      expect(row.updatedAt.toISOString()).toBe(asset.updatedAt.toISOString())
    })

    test('running it a second time writes nothing', async () => {
      const queue = setup()
      const path = await writeJpeg('twice-orientation', { orientation: 6 })
      const asset = await insertAsset({ originalPath: path, exif: { orientation: null } })

      await queue.enqueue(ORIENTATION_REPAIR_JOB, {})
      await queue.drain()
      const first = await read(asset.id)

      await queue.enqueue(ORIENTATION_REPAIR_JOB, {})
      await queue.drain()
      const second = await read(asset.id)

      expect(second.exif).toEqual(first.exif)
      expect(second.updatedAt.toISOString()).toBe(first.updatedAt.toISOString())
    })

    test('walks past a full batch by re-enqueueing itself', async () => {
      const queue = setup()
      const ids: string[] = []
      for (let i = 0; i <= REPAIR_BATCH; i++) {
        const path = await writeJpeg(`orient-batch-${i}`, { orientation: 6 })
        const asset = await insertAsset({ originalPath: path, exif: { orientation: null } })
        ids.push(asset.id)
      }

      await queue.enqueue(ORIENTATION_REPAIR_JOB, {})
      await queue.drain()

      const rows = await db.select().from(assets).where(inArray(assets.id, ids))
      expect(rows).toHaveLength(REPAIR_BATCH + 1)
      for (const row of rows) expect(row.exif).toMatchObject({ orientation: 6 })

      const runs = await db.select().from(jobs).where(eq(jobs.name, ORIENTATION_REPAIR_JOB))
      expect(runs.length).toBeGreaterThan(1)
    })

    test('counts the rows the pass will examine', async () => {
      await insertAsset({ exif: null })
      await insertAsset({ exif: { orientation: null } })
      await insertAsset({ exif: { orientation: 6 } })
      await insertAsset({ exif: null, type: 'video', mimeType: 'video/mp4' })

      expect(await countRepairCandidates(db, 'exifOrientation')).toBe(2)
    })
  })
})
