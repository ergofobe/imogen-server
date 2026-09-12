import { and, eq, isNotNull, isNull, or, sql } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { assets } from '../db/schema.ts'

export type IdentityKeys = {
  checksum?: string
  contentHash?: string | null
  deviceAssetId?: string | null
}

export type AssetRow = typeof assets.$inferSelect

export type ExistingAsset = {
  row: AssetRow
  /** The match was in the trash and has just been brought back. */
  restored: boolean
  /**
   * The caller holds the photograph's own bytes -- the checksum or the content hash --
   * rather than only a device asset id, which is a name the client chose and may have
   * moved to a different file since (#61).
   */
  matchedBytes: boolean
}

/**
 * The asset the owner already has for these keys, or nothing.
 *
 * Two of the keys are the bytes: the file checksum (the same bytes) and the content
 * hash (the same media payload under rewritten metadata, #60). The third is the
 * client's own device asset id (#61), a string the client chose. The ranking follows
 * that: a match by the bytes outranks one by the id; among matches of the same
 * standing a live row outranks a trashed one; then the surer key; then the oldest row,
 * so a library that predates the content hash answers the same way every time.
 * Liveness sits where it does because a live twin already holds the photograph, and
 * restoring a trashed exact copy beside it would hand the owner the pair #60 exists to
 * prevent, whereas a live row that merely shares a device asset id is not the
 * photograph the bytes name and must not be answered in its place.
 *
 * Shared by the resumable-upload fast path, which knows only what the client sent, and
 * the ingest claim, which has the bytes. A trashed asset still counts: the checksum's
 * unique index would refuse a second row anyway, and the other keys follow the same
 * rule so the three cannot disagree about what "already have it" means. It is restored
 * on the way out, which is why this takes `update` and is a claim rather than a find.
 * An upload is the owner asking for the photograph, and that outranks a trash that
 * exists to undo mistakes; before this the upload answered `duplicate: true`, dropped
 * the bytes, and the retention sweep destroyed the row on schedule (#64).
 *
 * A vaulted asset is matched only by its bytes. The vault's promise is that knowing an
 * id is not enough to read what was put away, and a device asset id is exactly such a
 * guess; the bytes are the caller proving it already holds the photograph (#65).
 */
export async function claimExistingAsset(
  db: Pick<Database, 'select' | 'update'>,
  ownerId: string,
  keys: IdentityKeys,
): Promise<ExistingAsset | undefined> {
  const conditions = [
    keys.checksum ? eq(assets.checksum, keys.checksum) : undefined,
    keys.contentHash ? eq(assets.contentHash, keys.contentHash) : undefined,
    keys.deviceAssetId
      ? and(eq(assets.deviceAssetId, keys.deviceAssetId), isNull(assets.vaultedAt))
      : undefined,
  ].filter((c) => c !== undefined)
  if (conditions.length === 0) return undefined

  const sameBytes = sql`${assets.checksum} = ${keys.checksum ?? ''}`
  const samePayload = sql`${assets.contentHash} = ${keys.contentHash ?? ''}`
  const [row] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.ownerId, ownerId), or(...conditions)))
    .orderBy(
      sql`case when ${sameBytes} or ${samePayload} then 0 else 1 end`,
      sql`case when ${assets.deletedAt} is null then 0 else 1 end`,
      sql`case when ${sameBytes} then 0 else 1 end`,
      assets.createdAt,
      assets.id,
    )
    .limit(1)
  if (!row) return undefined

  const matchedBytes =
    (keys.checksum !== undefined && row.checksum === keys.checksum) ||
    (keys.contentHash != null && row.contentHash === keys.contentHash)
  if (!row.deletedAt) return { row, restored: false, matchedBytes }

  // Guarded on `deletedAt` so a sweep that destroyed the row in the meantime reads as
  // no match, and the upload stores the photograph afresh rather than pointing at a
  // row that is gone.
  const [restored] = await db
    .update(assets)
    .set({ deletedAt: null, updatedAt: new Date() })
    .where(and(eq(assets.id, row.id), isNotNull(assets.deletedAt)))
    .returning()
  return restored ? { row: restored, restored: true, matchedBytes } : undefined
}

/**
 * Whether a vaulted asset holds this device asset id. The claim above never matches
 * one by the id, so bytes that share only the id become a new asset, and that asset
 * cannot carry the id while the vaulted row keeps it under the unique index.
 */
export async function deviceAssetIdIsVaulted(
  db: Pick<Database, 'select'>,
  ownerId: string,
  deviceAssetId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: assets.id })
    .from(assets)
    .where(
      and(
        eq(assets.ownerId, ownerId),
        eq(assets.deviceAssetId, deviceAssetId),
        isNotNull(assets.vaultedAt),
      ),
    )
    .limit(1)
  return row !== undefined
}
