import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { assets, users } from '../db/schema.ts'
import { createTestDatabase } from '../test/harness.ts'
import { toAsset } from './serialize.ts'

const harness = await createTestDatabase()
const db: Database = harness.db

afterAll(() => harness.close())

let ownerId: string

beforeEach(async () => {
  await db.execute(sql`truncate assets, users cascade`)
  const [owner] = await db
    .insert(users)
    .values({ email: 'owner@example.com', name: 'Owner' })
    .returning()
  ownerId = owner!.id
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
      capturedAt: new Date('2024-01-01T12:00:00Z'),
      ...overrides,
    })
    .returning()
  return row!
}

describe('location', () => {
  test('serialises a complete coordinate pair', async () => {
    const row = await addAsset({ latitude: 38.7223, longitude: -9.1393, altitude: 12 })

    expect(toAsset(row).location).toEqual({
      latitude: 38.7223,
      longitude: -9.1393,
      altitude: 12,
      place: null,
    })
  })

  test('reports no location when a coordinate is missing', async () => {
    const row = await addAsset({ latitude: 38.7223, longitude: null })

    expect(toAsset(row).location).toBeNull()
  })

  /**
   * A GPS rational with a zero denominator reads back as NaN, and NaN survives every
   * guard that looks for null: Postgres stores it as a non-null double, so the row
   * satisfies `latitude !== null`, and `JSON.stringify` then writes it out as `null`
   * because JSON has no NaN literal. The client sees a location object with a null
   * coordinate, which no port's model allows, and the upload fails to deserialise.
   */
  test('does not treat a NaN coordinate as a location', async () => {
    const row = await addAsset({ latitude: Number.NaN, longitude: 12.5 })

    // The premise: the database really did keep it, and it really is not null.
    expect(row.latitude).toBeNaN()
    expect(row.latitude).not.toBeNull()

    expect(toAsset(row).location).toBeNull()
  })

  test('does not carry a NaN altitude onto an otherwise good coordinate', async () => {
    const row = await addAsset({ latitude: 38.7223, longitude: -9.1393, altitude: Number.NaN })

    expect(toAsset(row).location?.altitude).toBeNull()
  })
})
