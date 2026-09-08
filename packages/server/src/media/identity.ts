import { and, eq, or, sql } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { assets } from '../db/schema.ts'

export type IdentityKeys = {
  checksum?: string
  contentHash?: string | null
  deviceAssetId?: string | null
}

/**
 * The asset the owner already has for these keys, ranked live before trashed, then by
 * how sure each key is: the same bytes, then the same media payload under rewritten
 * metadata (#60), then the client's own device asset id (#61). Ties among content twins
 * go to the oldest row, so a library that predates the content hash answers the same
 * way every time.
 *
 * Shared by the resumable-upload fast path, which knows only what the client sent, and
 * the ingest claim, which has the bytes. A trashed asset still counts: the checksum's
 * unique index would refuse a second row anyway, and the other keys follow the same
 * rule so the three cannot disagree about what "already have it" means.
 *
 * A trashed match is restored on the way out, which is why this takes `update` and is
 * a claim rather than a find. Before that, the upload answered `duplicate: true`, dropped
 * the bytes, and the retention sweep destroyed the row on schedule: a backup the client
 * watched succeed, and a library left holding nothing (#64). An upload is the owner
 * asking for the photograph, and that outranks a trash that exists to undo mistakes.
 * Liveness ranks above the key for the same reason in reverse: when a live twin already
 * holds the photograph, resurrecting a trashed exact copy beside it would hand the owner
 * the very pair of copies #60 exists to prevent.
 */
export async function claimExistingAsset(
  db: Pick<Database, 'select' | 'update'>,
  ownerId: string,
  keys: IdentityKeys,
): Promise<string | undefined> {
  const conditions = [
    keys.checksum ? eq(assets.checksum, keys.checksum) : undefined,
    keys.contentHash ? eq(assets.contentHash, keys.contentHash) : undefined,
    keys.deviceAssetId ? eq(assets.deviceAssetId, keys.deviceAssetId) : undefined,
  ].filter((c) => c !== undefined)
  if (conditions.length === 0) return undefined

  const [row] = await db
    .select({ id: assets.id, deletedAt: assets.deletedAt })
    .from(assets)
    .where(and(eq(assets.ownerId, ownerId), or(...conditions)))
    .orderBy(
      sql`case when ${assets.deletedAt} is null then 0 else 1 end`,
      sql`case when ${assets.checksum} = ${keys.checksum ?? ''} then 0
               when ${assets.contentHash} = ${keys.contentHash ?? ''} then 1
               else 2 end`,
      assets.createdAt,
      assets.id,
    )
    .limit(1)
  if (!row) return undefined

  if (row.deletedAt) {
    await db
      .update(assets)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(eq(assets.id, row.id))
  }
  return row.id
}
