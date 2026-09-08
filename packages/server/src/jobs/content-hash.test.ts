import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq, inArray, isNotNull, sql } from 'drizzle-orm'
import sharp from 'sharp'
import type { Database } from '../db/index.ts'
import { assets, jobs, settings, users } from '../db/schema.ts'
import { contentHash } from '../media/content-hash.ts'
import { LocalStorage } from '../media/storage.ts'
import { createTestConfig, createTestDatabase, removeTestConfig } from '../test/harness.ts'
import {
  CONTENT_HASH_BACKFILL_JOB,
  registerContentHashJobs,
  scheduleContentHashBackfill,
} from './content-hash.ts'
import { JobQueue } from './queue.ts'

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

/** Distinct pixels per seed, so two calls never collide on the JPEG's own content hash. */
async function makeJpeg(seed: string): Promise<Buffer> {
  const n = [...seed].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 251, 7)
  return sharp({
    create: {
      width: 80,
      height: 60,
      channels: 3,
      background: { r: n, g: (n * 3) % 256, b: (n * 7) % 256 },
    },
  })
    .jpeg()
    .toBuffer()
}

function setup() {
  const queue = new JobQueue(db, { concurrency: 1, idlePollMs: 5 })
  registerContentHashJobs(queue, { db, storage })
  return queue
}

describe('backfilling content_hash for assets uploaded before it existed', () => {
  let ownerId: string

  beforeEach(async () => {
    const [user] = await db
      .insert(users)
      .values({ email: 'owner@example.com', name: 'Owner' })
      .returning()
    ownerId = user!.id
  })

  /** An asset row pointing at `originalPath`, with a fresh checksum so rows never collide. */
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
        capturedAt: new Date(),
        ...overrides,
      })
      .returning()
    return asset!
  }

  test('hashes a known format, leaves an unsupported one null, and records the done key', async () => {
    const queue = setup()

    const jpeg = await makeJpeg('known')
    const jpegPath = `${crypto.randomUUID()}.jpg`
    await storage.write(jpegPath, jpeg)
    const jpegAsset = await insertAsset({ originalPath: jpegPath })

    const unknownPath = `${crypto.randomUUID()}.bin`
    await storage.write(unknownPath, Buffer.from('not media'))
    const unknownAsset = await insertAsset({ originalPath: unknownPath })

    expect(await scheduleContentHashBackfill(queue, db)).toBe(true)
    await queue.drain()

    const [jpegRow] = await db.select().from(assets).where(eq(assets.id, jpegAsset.id))
    expect(jpegRow!.contentHash).toBe(await contentHash(storage.absolutePath(jpegPath)))

    const [unknownRow] = await db.select().from(assets).where(eq(assets.id, unknownAsset.id))
    expect(unknownRow!.contentHash).toBeNull()

    const [done] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, 'assets.contentHashBackfillDone'))
    expect(done).toBeDefined()
  })

  test('includes trashed assets in the walk', async () => {
    const queue = setup()

    const jpeg = await makeJpeg('trashed')
    const path = `${crypto.randomUUID()}.jpg`
    await storage.write(path, jpeg)
    const trashed = await insertAsset({ originalPath: path, deletedAt: new Date() })

    expect(await scheduleContentHashBackfill(queue, db)).toBe(true)
    await queue.drain()

    const [row] = await db.select().from(assets).where(eq(assets.id, trashed.id))
    expect(row!.contentHash).toBe(await contentHash(storage.absolutePath(path)))
  })

  test('skips a row whose file is missing on disk without failing the job', async () => {
    const queue = setup()
    const missing = await insertAsset({ originalPath: `${crypto.randomUUID()}.jpg` })

    expect(await scheduleContentHashBackfill(queue, db)).toBe(true)
    await queue.drain()

    const [row] = await db.select().from(assets).where(eq(assets.id, missing.id))
    expect(row!.contentHash).toBeNull()

    const failed = await db.select().from(jobs).where(eq(jobs.status, 'failed'))
    expect(failed).toEqual([])

    const [done] = await db
      .select()
      .from(settings)
      .where(eq(settings.key, 'assets.contentHashBackfillDone'))
    expect(done).toBeDefined()
  })

  test('schedules the backfill once, and never again afterwards', async () => {
    const queue = setup()

    expect(await scheduleContentHashBackfill(queue, db)).toBe(true)
    await queue.drain()

    expect(await scheduleContentHashBackfill(queue, db)).toBe(false)
    expect(
      await db.select().from(jobs).where(eq(jobs.name, CONTENT_HASH_BACKFILL_JOB)),
    ).toHaveLength(1)
  })

  test('walks past a full batch via re-enqueue', async () => {
    const queue = setup()

    const jpeg = await makeJpeg('batch')
    const path = `${crypto.randomUUID()}.jpg`
    await storage.write(path, jpeg)

    const ids: string[] = []
    for (let i = 0; i < 52; i++) {
      const asset = await insertAsset({ originalPath: path })
      ids.push(asset.id)
    }

    expect(await scheduleContentHashBackfill(queue, db)).toBe(true)
    await queue.drain()

    const rows = await db.select().from(assets).where(inArray(assets.id, ids))
    expect(rows).toHaveLength(52)
    const expectedHash = await contentHash(storage.absolutePath(path))
    for (const row of rows) expect(row.contentHash).toBe(expectedHash)

    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(assets)
      .where(isNotNull(assets.contentHash))
    expect(row!.count).toBe(52)

    // More than one batch means more than one job ran to finish the walk.
    const runs = await db.select().from(jobs).where(eq(jobs.name, CONTENT_HASH_BACKFILL_JOB))
    expect(runs.length).toBeGreaterThan(1)
  })
})
