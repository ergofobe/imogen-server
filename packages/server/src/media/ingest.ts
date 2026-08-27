import { rm, stat } from 'node:fs/promises'
import type { AssetUploadMetadata, AssetUploadResult } from '@imogen/shared'
import { and, eq, sql } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { assetFiles, assets, users } from '../db/schema.ts'
import { conflict, quotaExceeded, unsupportedMediaType } from '../lib/errors.ts'
import type { MediaPipeline } from './pipeline.ts'
import { toAsset } from './serialize.ts'
import { derivativePath, hashFile, libraryPath, type StorageDriver } from './storage.ts'

export const INGEST_JOB = 'asset.ingest'

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
   */
  async ingest(input: IngestInput): Promise<AssetUploadResult> {
    const type = this.pipeline.classify(input.mimeType, input.filename)
    if (!type) {
      await rm(input.tempPath, { force: true })
      throw unsupportedMediaType(`imogen cannot store "${input.filename}"`)
    }

    const checksum = await hashFile(input.tempPath)
    const { size } = await stat(input.tempPath)

    const existing = await this.findByChecksum(input.ownerId, checksum)
    if (existing) {
      // Already have these exact bytes. Drop the copy rather than storing it twice.
      await rm(input.tempPath, { force: true })
      return { asset: await this.hydrate(existing.id), duplicate: true }
    }

    await this.assertWithinQuota(input.ownerId, size)

    // Capture time is provisional until the pipeline reads EXIF, but the library path
    // depends on it, so use the best guess available now.
    const provisionalCapturedAt = input.metadata.capturedAt
      ? new Date(input.metadata.capturedAt)
      : await fileModifiedTime(input.tempPath)

    const [row] = await this.db
      .insert(assets)
      .values({
        ownerId: input.ownerId,
        type,
        status: 'pending',
        originalFilename: input.metadata.filename ?? input.filename,
        mimeType: input.mimeType,
        checksum,
        sizeBytes: size,
        originalPath: '',
        capturedAt: provisionalCapturedAt,
        capturedAtIsExact: false,
        favorite: input.metadata.favorite ?? false,
        deviceAssetId: input.metadata.deviceAssetId ?? null,
        description: input.metadata.description ?? null,
        latitude: input.metadata.location?.latitude ?? null,
        longitude: input.metadata.location?.longitude ?? null,
        altitude: input.metadata.location?.altitude ?? null,
      })
      .returning()

    const asset = row!
    const relativePath = libraryPath({
      ownerId: input.ownerId,
      assetId: asset.id,
      capturedAt: provisionalCapturedAt,
      filename: input.filename,
    })

    try {
      const stored = await this.storage.moveInto(relativePath, input.tempPath)
      await this.db.update(assets).set({ originalPath: stored.path }).where(eq(assets.id, asset.id))
      await this.db.insert(assetFiles).values({
        assetId: asset.id,
        variant: 'original',
        path: stored.path,
        mimeType: input.mimeType,
        sizeBytes: stored.sizeBytes,
      })
    } catch (error) {
      // Never leave a row pointing at bytes that are not there.
      await this.db.delete(assets).where(eq(assets.id, asset.id))
      await rm(input.tempPath, { force: true })
      throw error
    }

    await this.db
      .update(users)
      .set({ usedBytes: sql`${users.usedBytes} + ${size}` })
      .where(eq(users.id, input.ownerId))

    await this.enqueue(INGEST_JOB, { assetId: asset.id })

    return { asset: await this.hydrate(asset.id), duplicate: false }
  }

  /** Generates derivatives and fills in metadata. Runs in a worker, never on a request. */
  async process(assetId: string): Promise<void> {
    const [asset] = await this.db.select().from(assets).where(eq(assets.id, assetId)).limit(1)
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
    // taken, not when it was uploaded.
    const capturedAt = result.capturedAt ?? asset.capturedAt
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

  private async findByChecksum(ownerId: string, checksum: string) {
    const [row] = await this.db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.ownerId, ownerId), eq(assets.checksum, checksum)))
      .limit(1)
    return row ?? null
  }

  private async assertWithinQuota(ownerId: string, incoming: number) {
    const [user] = await this.db
      .select({ quotaBytes: users.quotaBytes, usedBytes: users.usedBytes })
      .from(users)
      .where(eq(users.id, ownerId))
      .limit(1)
    if (!user?.quotaBytes) return
    if (user.usedBytes + incoming > user.quotaBytes) {
      throw quotaExceeded('This upload would exceed your storage quota')
    }
  }

  private async hydrate(assetId: string) {
    const [row] = await this.db.select().from(assets).where(eq(assets.id, assetId)).limit(1)
    if (!row) throw conflict('Asset disappeared during upload')
    return toAsset(row)
  }
}

async function fileModifiedTime(path: string): Promise<Date> {
  const info = await stat(path).catch(() => null)
  return info?.mtime ?? new Date()
}
