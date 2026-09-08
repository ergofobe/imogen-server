import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { assets, faces, jobs, people, settings, users } from '../db/schema.ts'
import type { FaceService } from '../faces/faces.ts'
import type { ModelStore } from '../faces/models.ts'
import { createTestDatabase } from '../test/harness.ts'
import { FACE_DETECT_JOB, FACE_REPAIR_JOB, registerFaceJobs, scheduleFaceRepair } from './faces.ts'
import { JobQueue } from './queue.ts'

const harness = await createTestDatabase()
const db: Database = harness.db

afterAll(() => harness.close())

beforeEach(async () => {
  await db.execute(sql`truncate jobs, users, assets, faces, people, settings cascade`)
})

function setup(modelsReady: boolean) {
  const queue = new JobQueue(db, { concurrency: 1, idlePollMs: 5 })
  const scanned: string[] = []
  const rechecked: string[] = []
  const faces = {
    modelsReady: async () => modelsReady,
    isEnabled: async () => true,
    processAsset: async (assetId: string) => {
      scanned.push(assetId)
      return 0
    },
    recheckAsset: async (assetId: string) => {
      rechecked.push(assetId)
      return false
    },
  } as unknown as FaceService
  registerFaceJobs(queue, { db, faces, models: {} as ModelStore, queue })
  return { queue, scanned, rechecked }
}

describe('detecting faces before the models have arrived', () => {
  test('waits for the download instead of failing', async () => {
    const { queue, scanned } = setup(false)
    await queue.enqueue(FACE_DETECT_JOB, { assetId: 'asset-1' })

    await queue.drain()

    expect(scanned).toEqual([])
    const waiting = await db.select().from(jobs).where(eq(jobs.status, 'queued'))
    expect(waiting).toHaveLength(1)
    expect(waiting[0]!.name).toBe(FACE_DETECT_JOB)
    expect(waiting[0]!.payload).toMatchObject({ assetId: 'asset-1', waited: 1 })
    expect(waiting[0]!.runAt.getTime()).toBeGreaterThan(Date.now())
  })

  test('scans as usual once they are on disk', async () => {
    const { queue, scanned } = setup(true)
    await queue.enqueue(FACE_DETECT_JOB, { assetId: 'asset-1' })

    await queue.drain()

    expect(scanned).toEqual(['asset-1'])
  })
})

/**
 * The repair pass walks the photographs that carry faces and asks each whether it still
 * has any. It is a one-off for libraries that accumulated stale faces before the fix in
 * #46, so it has to get all the way to the end exactly once, and then stop for good.
 */
describe('repairing photographs that kept faces they no longer have', () => {
  let ownerId: string

  beforeEach(async () => {
    const [user] = await db
      .insert(users)
      .values({ email: 'owner@example.com', name: 'Owner' })
      .returning()
    ownerId = user!.id
  })

  /** An asset with `count` faces on it, so the repair pass has something to walk. */
  async function withFaces(count: number, overrides: Partial<typeof assets.$inferInsert> = {}) {
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
    const [person] = await db.insert(people).values({ ownerId }).returning()
    for (let i = 0; i < count; i++) {
      await db.insert(faces).values({
        assetId: asset!.id,
        ownerId,
        personId: person!.id,
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        score: 0.9,
        embedding: Array(512).fill(0),
      })
    }
    return asset!
  }

  test('re-checks every photograph that has faces, once each', async () => {
    const { queue, rechecked } = setup(true)
    const a = await withFaces(1)
    // Two faces, one asset: a group photo must not be re-checked twice.
    const b = await withFaces(2)

    await queue.enqueue(FACE_REPAIR_JOB, {})
    await queue.drain()

    expect(rechecked.toSorted()).toEqual([a.id, b.id].toSorted())
  })

  test('never opens a photograph that has no faces to lose', async () => {
    const { queue, rechecked } = setup(true)
    await withFaces(0)

    await queue.enqueue(FACE_REPAIR_JOB, {})
    await queue.drain()

    expect(rechecked).toEqual([])
  })

  test('leaves vaulted and trashed photographs out of the walk', async () => {
    const { queue, rechecked } = setup(true)
    await withFaces(1, { vaultedAt: new Date() })
    await withFaces(1, { deletedAt: new Date() })
    const visible = await withFaces(1)

    await queue.enqueue(FACE_REPAIR_JOB, {})
    await queue.drain()

    expect(rechecked).toEqual([visible.id])
  })

  /**
   * Marked done only once the walk has actually finished. A server that restarts halfway
   * through starts the pass again rather than declaring a library repaired that is not:
   * re-checking a photograph twice costs a detection run and changes nothing, whereas
   * skipping one leaves stale faces in place for good.
   */
  test('marks itself done only after the last batch', async () => {
    const { queue } = setup(true)
    await withFaces(1)

    await queue.enqueue(FACE_REPAIR_JOB, {})
    await queue.drain()

    const [done] = await db.select().from(settings).where(eq(settings.key, 'faces.staleRepairDone'))
    expect(done).toBeDefined()
  })

  test('schedules the repair once, and never again afterwards', async () => {
    const { queue } = setup(true)
    const faces = { isEnabled: async () => true, modelsReady: async () => true } as FaceService

    expect(await scheduleFaceRepair(queue, db, faces)).toBe(true)
    await queue.drain()

    // Second boot of an already-repaired server.
    expect(await scheduleFaceRepair(queue, db, faces)).toBe(false)
    expect(await db.select().from(jobs).where(eq(jobs.name, FACE_REPAIR_JOB))).toHaveLength(1)
  })

  test('does not schedule the repair while face grouping is off', async () => {
    const { queue } = setup(true)
    const faces = { isEnabled: async () => false, modelsReady: async () => true } as FaceService

    expect(await scheduleFaceRepair(queue, db, faces)).toBe(false)
    expect(await db.select().from(jobs)).toBeEmpty()
  })

  test('does not schedule the repair before the models are on disk', async () => {
    const { queue } = setup(true)
    const faces = { isEnabled: async () => true, modelsReady: async () => false } as FaceService

    expect(await scheduleFaceRepair(queue, db, faces)).toBe(false)
    expect(await db.select().from(jobs)).toBeEmpty()
  })
})
