import { rm, stat } from 'node:fs/promises'
import type { AssetUploadMetadata, AssetUploadResult } from '@imogen/shared'
import { and, eq, sql } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { assetFiles, assets, users } from '../db/schema.ts'
import { conflict, quotaExceeded, unsupportedMediaType } from '../lib/errors.ts'
import { contentHash } from './content-hash.ts'
import { type AssetRow, claimExistingAsset, deviceAssetIdIsVaulted } from './identity.ts'
import type { MediaPipeline } from './pipeline.ts'
import { toAsset } from './serialize.ts'
import { derivativePath, hashFile, libraryPath, type StorageDriver } from './storage.ts'

export const INGEST_JOB = 'asset.ingest'

/**
 * The wire result, plus whether the match came back from the trash. The routes read
 * that to recount people afterwards, the way the restore route does; it never leaves
 * the server.
 */
export type IngestResult = AssetUploadResult & { restored: boolean }

export type IngestInput = {
  ownerId: string
  /** Absolute path to the already-received bytes, outside the library. */
  tempPath: string
  filename: string
  mimeType: string
  metadata: AssetUploadMetadata
}

export class IngestService {
  constructor(
    private readonly db: Database,
    /** Originals. Never modified after they land. */
    private readonly storage: StorageDriver,
    /** Thumbnails and previews, which live apart so they can be regenerated or purged. */
    private readonly derivatives: StorageDriver,
    private readonly pipeline: MediaPipeline,
    private readonly enqueue: (name: string, payload: Record<string, unknown>) => Promise<string>,
  ) {}

  /**
   * Registers an uploaded file and schedules its processing. Returns as soon as the
   * bytes are safely in the library — an upload should not wait on thumbnailing, so the
   * asset comes back `pending` and the client shows a placeholder.
   *
   * Every await in here is server-side (hashing a temp file, a query, a filesystem
   * move); nothing waits on the client, whose bytes are already fully spooled to
   * `input.tempPath` by the time this runs. That matters for `claimIdentity`, below: a
   * lock held only across awaits like these can never be abandoned by a client that
   * disconnects, because there is nothing left to disconnect from. See #9.
   */
  async ingest(input: IngestInput): Promise<IngestResult> {
    const type = this.pipeline.classify(input.mimeType, input.filename)
    if (!type) {
      await rm(input.tempPath, { force: true })
      throw unsupportedMediaType(`imogen cannot store "${input.filename}"`)
    }

    const [checksum, content, { size }] = await Promise.all([
      hashFile(input.tempPath),
      contentHash(input.tempPath),
      stat(input.tempPath),
    ])

    // Capture time is provisional until the pipeline reads EXIF, but the library path
    // depends on it, so use the best guess available now. Whether it came from the client
    // is derived from the same value, so the flag cannot drift from what was stored.
    const fromClient = input.metadata.capturedAt
    const provisionalCapturedAt = fromClient
      ? new Date(fromClient)
      : await fileModifiedTime(input.tempPath)

    const claim = await this.claimIdentity(input.ownerId, size, {
      checksum,
      contentHash: content,
      type,
      status: 'pending',
      originalFilename: input.metadata.filename ?? input.filename,
      mimeType: input.mimeType,
      originalPath: '',
      capturedAt: provisionalCapturedAt,
      capturedAtIsExact: false,
      capturedAtFromClient: Boolean(fromClient),
      favorite: input.metadata.favorite ?? false,
      deviceAssetId: input.metadata.deviceAssetId ?? null,
      description: input.metadata.description ?? null,
      latitude: input.metadata.location?.latitude ?? null,
      longitude: input.metadata.location?.longitude ?? null,
      altitude: input.metadata.location?.altitude ?? null,
    })

    if (claim.duplicate) {
      // Already have this photograph. Drop the copy rather than storing it twice.
      await rm(input.tempPath, { force: true })
      const row = await this.retryIfFailed(claim.row)
      return { asset: toAsset(row), duplicate: true, restored: claim.restored }
    }

    const assetId = claim.id
    const relativePath = libraryPath({
      ownerId: input.ownerId,
      assetId,
      capturedAt: provisionalCapturedAt,
      filename: input.filename,
    })

    try {
      const stored = await this.storage.moveInto(relativePath, input.tempPath)
      await this.db.update(assets).set({ originalPath: stored.path }).where(eq(assets.id, assetId))
      await this.db.insert(assetFiles).values({
        assetId,
        variant: 'original',
        path: stored.path,
        mimeType: input.mimeType,
        sizeBytes: stored.sizeBytes,
      })
    } catch (error) {
      // Never leave a row pointing at bytes that are not there.
      await this.db.delete(assets).where(eq(assets.id, assetId))
      await rm(input.tempPath, { force: true })
      throw error
    }

    await this.db
      .update(users)
      .set({ usedBytes: sql`${users.usedBytes} + ${size}` })
      .where(eq(users.id, input.ownerId))

    await this.enqueue(INGEST_JOB, { assetId })

    return { asset: await this.hydrate(assetId), duplicate: false, restored: false }
  }

  /**
   * Queues another attempt at a photograph the pipeline rejected, and answers with the
   * row as it now stands.
   *
   * Sending the file again is the owner asking for the derivatives it never got. The
   * bytes in the library are already the bytes just sent, so there is nothing to store,
   * and before this the duplicate answer stopped there: the row kept its `failed`
   * status and its checksum, every later upload matched it, and the only way out was to
   * wait for the retention sweep to destroy it (#68).
   *
   * The update is guarded on the status that was read, so two uploads racing to retry
   * the same photograph queue one job between them.
   */
  async retryIfFailed(row: AssetRow): Promise<AssetRow> {
    if (row.status !== 'failed') return row

    const [pending] = await this.db
      .update(assets)
      .set({ status: 'pending', processingError: null, updatedAt: new Date() })
      .where(and(eq(assets.id, row.id), eq(assets.status, 'failed')))
      .returning()
    if (!pending) return (await this.rowOf(row.id)) ?? row

    try {
      await this.enqueue(INGEST_JOB, { assetId: row.id })
    } catch (error) {
      // Put the failure back if the job never reached the queue. `pending` with nothing
      // queued is a photograph no retry can reach again -- this one refuses it, and the
      // error the owner was shown is gone with it -- which is worse than the `failed` it
      // replaced.
      await this.db
        .update(assets)
        .set({
          status: 'failed',
          processingError: row.processingError,
          updatedAt: new Date(),
        })
        .where(and(eq(assets.id, row.id), eq(assets.status, 'pending')))
      throw error
    }
    return pending
  }

  /** Generates derivatives and fills in metadata. Runs in a worker, never on a request. */
  async process(assetId: string): Promise<void> {
    const asset = await this.rowOf(assetId)
    if (!asset) return

    await this.db.update(assets).set({ status: 'processing' }).where(eq(assets.id, assetId))

    const absolute = this.storage.absolutePath(asset.originalPath)
    const result = await this.pipeline.process(absolute, {
      mimeType: asset.mimeType,
      filename: asset.originalFilename,
    })

    if (result.error) {
      await this.db
        .update(assets)
        .set({ status: 'failed', processingError: result.error, updatedAt: new Date() })
        .where(eq(assets.id, assetId))
      return
    }

    const written: Array<{ variant: 'thumbnail' | 'preview'; path: string; size: number }> = []
    for (const variant of ['thumbnail', 'preview'] as const) {
      const buffer = result[variant]
      if (!buffer) continue
      const path = derivativePath(assetId, variant)
      const stored = await this.derivatives.write(path, new Blob([new Uint8Array(buffer)]))
      written.push({ variant, path: stored.path, size: stored.sizeBytes })
    }

    for (const file of written) {
      await this.db
        .insert(assetFiles)
        .values({
          assetId,
          variant: file.variant,
          path: file.path,
          mimeType: 'image/webp',
          sizeBytes: file.size,
        })
        .onConflictDoUpdate({
          target: [assetFiles.assetId, assetFiles.variant],
          set: { path: file.path, sizeBytes: file.size },
        })
    }

    // EXIF beats the provisional timestamp; a scanned photo should sort by when it was
    // taken, not when it was uploaded. But only an EXIF time carrying its offset is
    // actually an instant. Without one, reading the wall clock as UTC moves the
    // photograph by the device's offset -- four hours for a phone in New York, enough to
    // land it on the previous day in a timeline bucketed by UTC date -- so a capture time
    // the client already resolved is the better answer. The unanchored reading is still
    // better than a file mtime, which is what the provisional value falls back to.
    const keepClientTime = asset.capturedAtFromClient && !result.capturedAtHasOffset
    const capturedAt = keepClientTime ? asset.capturedAt : (result.capturedAt ?? asset.capturedAt)
    // A file whose EXIF carries no coordinates leaves whatever is already on the row
    // alone. Writing null here would erase a location the uploader supplied, or one the
    // owner typed in, the moment the pipeline got round to the photograph.
    const location = result.location
      ? {
          latitude: result.location.latitude,
          longitude: result.location.longitude,
          altitude: result.location.altitude ?? null,
        }
      : {}
    await this.db
      .update(assets)
      .set({
        status: 'ready',
        width: result.width,
        height: result.height,
        duration: result.duration,
        capturedAt,
        capturedAtIsExact: result.capturedAt !== null,
        exif: result.exif,
        ...location,
        placeholderColor: result.placeholderColor,
        processingError: null,
        updatedAt: new Date(),
      })
      .where(eq(assets.id, assetId))
  }

  /**
   * Finds the asset the owner already has for this upload, or reserves one, atomically.
   *
   * Three things identify an upload as a photograph already in the library, checked in
   * order of confidence: the file checksum (the same bytes), the content hash (the same
   * media payload under rewritten metadata — every export pipeline does this, see #60),
   * and the client's own device asset id (a re-sent id is the client saying "this is
   * that one", even when it has edited the file since, see #61). Refusing the last with
   * a 409 was rejected: a reinstalled phone app would retry it forever.
   *
   * Two uploads arriving together must not both pass those checks and both insert — one
   * would then trip a unique index and fail outright instead of coming back a tidy
   * `duplicate: true`, and for the content hash, which is deliberately not unique, both
   * would land. A per-owner advisory lock serialises that narrow window, the same
   * pattern `FaceService.recordFace` uses; it is per owner rather than per key because
   * one upload now claims three keys at once.
   *
   * The lock lives entirely inside this transaction, alongside the quota check and the
   * insert it guards — a few quick queries, nothing else. `lock_timeout` and
   * `statement_timeout` on the pool (see `db/index.ts`) bound how long a caller waits
   * here even if that invariant is ever broken by a future change.
   *
   * This closes the race between the dedup check and the insert, but not the ones on
   * either side of it: the row this reserves is visible, and `input.tempPath` removable
   * by a concurrent duplicate upload, before `ingest` has moved the bytes into the
   * library, and `usedBytes` is still incremented outside this transaction. Both are
   * pre-existing and out of scope here.
   */
  private async claimIdentity(
    ownerId: string,
    size: number,
    values: Omit<typeof assets.$inferInsert, 'ownerId' | 'sizeBytes'>,
  ): Promise<
    { duplicate: true; row: AssetRow; restored: boolean } | { duplicate: false; id: string }
  > {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ingest:${ownerId}`}))`)

      const existing = await claimExistingAsset(tx, ownerId, values)
      if (existing) return { duplicate: true, ...existing }

      const [user] = await tx
        .select({ quotaBytes: users.quotaBytes, usedBytes: users.usedBytes })
        .from(users)
        .where(eq(users.id, ownerId))
        .limit(1)
      if (user?.quotaBytes && user.usedBytes + size > user.quotaBytes) {
        throw quotaExceeded('This upload would exceed your storage quota')
      }

      // A vaulted photograph is matched only by its bytes, so bytes that share only its
      // device asset id are a new asset, and one that cannot carry the id while the
      // vaulted row holds it under the unique index.
      const deviceAssetId =
        values.deviceAssetId && (await deviceAssetIdIsVaulted(tx, ownerId, values.deviceAssetId))
          ? null
          : values.deviceAssetId
      const [row] = await tx
        .insert(assets)
        .values({ ownerId, sizeBytes: size, ...values, deviceAssetId })
        .returning({ id: assets.id })
      return { duplicate: false, id: row!.id }
    })
  }

  private async hydrate(assetId: string) {
    const row = await this.rowOf(assetId)
    if (!row) throw conflict('Asset disappeared during upload')
    return toAsset(row)
  }

  private async rowOf(assetId: string): Promise<AssetRow | undefined> {
    const [row] = await this.db.select().from(assets).where(eq(assets.id, assetId)).limit(1)
    return row
  }
}

async function fileModifiedTime(path: string): Promise<Date> {
  const info = await stat(path).catch(() => null)
  return info?.mtime ?? new Date()
}
