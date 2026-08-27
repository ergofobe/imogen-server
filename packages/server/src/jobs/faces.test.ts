import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { jobs } from '../db/schema.ts'
import type { FaceService } from '../faces/faces.ts'
import type { ModelStore } from '../faces/models.ts'
import { createTestDatabase } from '../test/harness.ts'
import { FACE_DETECT_JOB, registerFaceJobs } from './faces.ts'
import { JobQueue } from './queue.ts'

const harness = await createTestDatabase()
const db: Database = harness.db

afterAll(() => harness.close())

beforeEach(async () => {
  await db.execute(sql`truncate jobs`)
})

function setup(modelsReady: boolean) {
  const queue = new JobQueue(db, { concurrency: 1, idlePollMs: 5 })
  const scanned: string[] = []
  const faces = {
    modelsReady: async () => modelsReady,
    isEnabled: async () => true,
    processAsset: async (assetId: string) => {
      scanned.push(assetId)
      return 0
    },
  } as unknown as FaceService
  registerFaceJobs(queue, { db, faces, models: {} as ModelStore, queue })
  return { queue, scanned }
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
