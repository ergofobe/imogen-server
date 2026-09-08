import type { Asset } from '@imogen/shared'
import type { AssetRow } from '../db/schema.ts'

/** Turns a database row into the shape the API contract promises. */
export function toAsset(row: AssetRow): Asset {
  return {
    id: row.id,
    ownerId: row.ownerId,
    type: row.type,
    status: row.status,
    originalFilename: row.originalFilename,
    mimeType: row.mimeType,
    checksum: row.checksum,
    sizeBytes: row.sizeBytes,
    width: row.width,
    height: row.height,
    duration: row.duration,
    capturedAt: row.capturedAt.toISOString(),
    capturedAtIsExact: row.capturedAtIsExact,
    capturedAtOriginal: row.capturedAtOriginal?.toISOString() ?? null,
    capturedAtOriginalIsExact: row.capturedAtOriginalIsExact ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
    favorite: row.favorite,
    archived: row.archived,
    description: row.description,
    exif: (row.exif as Asset['exif']) ?? null,
    location: toLocation(row),
    placeholderColor: row.placeholderColor,
    livePhotoVideoId: row.livePhotoVideoId,
    deviceAssetId: row.deviceAssetId,
  }
}

/**
 * A coordinate has to be a finite number to locate anything. NaN -- which is what a GPS
 * rational with a zero denominator decodes to -- passes a null check, and
 * `JSON.stringify` then writes it out as `null` because JSON has no NaN literal. That
 * hands the client a location object with a null coordinate, which no port's model
 * allows, so the response fails to deserialise instead of simply arriving without a
 * location. Exported because every payload carrying coordinates has to agree on this.
 */
export function isUsableCoordinate(value: number | null): value is number {
  return value !== null && Number.isFinite(value)
}

/** Half a pair fixes nothing on a map, so both coordinates go or neither does. */
function toLocation(row: AssetRow): Asset['location'] {
  if (!isUsableCoordinate(row.latitude) || !isUsableCoordinate(row.longitude)) return null
  return {
    latitude: row.latitude,
    longitude: row.longitude,
    altitude: isUsableCoordinate(row.altitude) ? row.altitude : null,
    place: row.place,
  }
}
