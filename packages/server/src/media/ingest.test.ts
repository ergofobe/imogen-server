import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { assets, users } from '../db/schema.ts'
import { createTestDatabase } from '../test/harness.ts'
import { INGEST_JOB, IngestService } from './ingest.ts'
import type { MediaPipeline } from './pipeline.ts'
import type { StorageDriver } from './storage.ts'

const harness = await createTestDatabase()

afterAll(() => harness.close())

let ownerId: string

beforeEach(async () => {
  await harness.db.execute(sql`truncate assets, users cascade`)
  const [user] = await harness.db
    .insert(users)
    .values({ email: 'owner@example.com', name: 'Owner' })
    .returning()
  ownerId = user!.id
})

/**
 * `retryIfFailed` reads and writes the row and hands the job to the queue; none of the
 * storage or the pipeline is reached, so none of it is built here.
 */
function ingestWith(enqueue: (name: string, payload: Record<string, unknown>) => Promise<string>) {
  const absent = {} as StorageDriver
  return new IngestService(harness.db, absent, absent, {} as MediaPipeline, enqueue)
}

async function addAsset(overrides: Partial<typeof assets.$inferInsert> = {}) {
  const [row] = await harness.db
    .insert(assets)
    .values({
      ownerId,
      type: 'image',
      status: 'failed',
      processingError: 'Could not decode this image',
      originalFilename: 'photo.jpg',
      mimeType: 'image/jpeg',
      checksum: '1'.repeat(64),
      sizeBytes: 1000,
      originalPath: 'x/photo.jpg',
      capturedAt: new Date('2024-01-01T12:00:00Z'),
      ...overrides,
    })
    .returning()
  return row!
}

async function rowOf(assetId: string) {
  const [row] = await harness.db.select().from(assets).where(eq(assets.id, assetId))
  return row!
}

describe('retrying a failed photograph', () => {
  test('queues the pipeline again and clears the error', async () => {
    const queued: Array<{ name: string; payload: Record<string, unknown> }> = []
    const row = await addAsset()

    const result = await ingestWith(async (name, payload) => {
      queued.push({ name, payload })
      return 'job'
    }).retryIfFailed(row)

    expect(queued).toEqual([{ name: INGEST_JOB, payload: { assetId: row.id } }])
    expect(result.status).toBe('pending')
    expect(result.processingError).toBeNull()
    expect(await rowOf(row.id)).toMatchObject({ status: 'pending', processingError: null })
  })

  test('leaves a photograph that is not failed alone', async () => {
    const row = await addAsset({ status: 'ready', processingError: null })

    const result = await ingestWith(async () => {
      throw new Error('nothing should be queued')
    }).retryIfFailed(row)

    expect(result.status).toBe('ready')
  })

  test('two uploads racing to retry one photograph queue one job between them', async () => {
    const queued: string[] = []
    const row = await addAsset()
    const service = ingestWith(async (_name, payload) => {
      queued.push(payload.assetId as string)
      return 'job'
    })

    await service.retryIfFailed(row)
    // The same row the first caller read: what the loser of the race is holding.
    const second = await service.retryIfFailed(row)

    expect(queued).toEqual([row.id])
    expect(second.status).toBe('pending')
  })

  test('puts the failure back when the job never reaches the queue', async () => {
    // A `pending` row with nothing queued is a photograph no later upload can retry --
    // this method refuses it -- and the error the owner was shown is gone with it.
    const row = await addAsset()
    const service = ingestWith(async () => {
      throw new Error('the queue is unreachable')
    })

    await expect(service.retryIfFailed(row)).rejects.toThrow('the queue is unreachable')

    expect(await rowOf(row.id)).toMatchObject({
      status: 'failed',
      processingError: 'Could not decode this image',
    })
  })
})
