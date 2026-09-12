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

  /**
   * A row stored before the ingest path applied the bound still has to stop being served
   * as a location: every port now decodes such a coordinate away, so what the row holds
   * is a location no client will ever show and no user is told to correct.
   */
  test('does not serve a latitude outside its range as a location', async () => {
    const row = await addAsset({ latitude: 200, longitude: 12.5 })

    expect(row.latitude).toBe(200)
    expect(toAsset(row).location).toBeNull()
  })

  // The bounds differ per coordinate, so a guard that checked both against 90 would pass
  // the case above and still let this one through.
  test('does not serve a longitude outside its range as a location', async () => {
    const row = await addAsset({ latitude: 38.7223, longitude: -200.5 })

    expect(toAsset(row).location).toBeNull()
  })

  // Without this, dropping every location the serializer is unsure of would pass the two
  // cases above.
  test('keeps a location sitting exactly on both bounds', async () => {
    const row = await addAsset({ latitude: -90, longitude: 180 })

    expect(toAsset(row).location).toMatchObject({ latitude: -90, longitude: 180 })
  })

  // Altitude has no bound of its own: a photograph taken from an aeroplane is still a
  // photograph of somewhere.
  test('keeps an altitude that would be out of range for a coordinate', async () => {
    const row = await addAsset({ latitude: 38.7223, longitude: -9.1393, altitude: 11_000 })

    expect(toAsset(row).location?.altitude).toBe(11_000)
  })
})
