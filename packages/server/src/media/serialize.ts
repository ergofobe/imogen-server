import type { Asset } from '@imogen/shared'
import type { AssetRow } from '../db/schema.ts'
import { isPlaceableLatitude, isPlaceableLongitude, isUsableAltitude } from './coordinates.ts'

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
 * Half a pair fixes nothing on a map, so both coordinates go or neither does. The bound
 * is applied here as well as on ingest because a row written before the pipeline checked
 * it has to stop being served as a location too.
 */
function toLocation(row: AssetRow): Asset['location'] {
  if (!isPlaceableLatitude(row.latitude) || !isPlaceableLongitude(row.longitude)) return null
  return {
    latitude: row.latitude,
    longitude: row.longitude,
    altitude: isUsableAltitude(row.altitude) ? row.altitude : null,
    place: row.place,
  }
}
