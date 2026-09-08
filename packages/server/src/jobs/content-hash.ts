import { and, eq, gt, isNull } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { assets } from '../db/schema.ts'
import { contentHash } from '../media/content-hash.ts'
import type { StorageDriver } from '../media/storage.ts'
import { isDone, markDone } from './done.ts'
import type { JobQueue } from './queue.ts'

export const CONTENT_HASH_BACKFILL_JOB = 'assets.contentHashBackfill'

/** Set once the backfill below has walked the whole library. */
const DONE_KEY = 'assets.contentHashBackfillDone'

/** How many assets one pass hashes before scheduling the next. */
const BATCH = 50

export type ContentHashJobDeps = {
  db: Database
  storage: StorageDriver
}

export function registerContentHashJobs(queue: JobQueue, deps: ContentHashJobDeps): void {
  /**
   * Walks assets that predate `content_hash`, hashing each from the file on disk.
   *
   * Batched and self-rescheduling rather than one long job, same reasoning as the face
   * backfill: a large library should make visible progress and survive a restart rather
   * than start over from nothing.
   */
  queue.register(CONTENT_HASH_BACKFILL_JOB, async (payload) => {
    const after = typeof payload.after === 'string' ? payload.after : null
    const batch = await pendingContentHash(deps.db, BATCH, after)

    for (const asset of batch) {
      // An upload that never finished has no file to hash.
      if (asset.originalPath === '') continue

      let hash: string | null
      try {
        hash = await contentHash(deps.storage.absolutePath(asset.originalPath))
      } catch {
        // A missing or unreadable file must not take the whole pass down with it.
        hash = null
      }
      if (hash !== null) {
        await deps.db.update(assets).set({ contentHash: hash }).where(eq(assets.id, asset.id))
      }
    }

    if (batch.length === BATCH) {
      await queue.enqueue(CONTENT_HASH_BACKFILL_JOB, { after: batch[batch.length - 1]!.id })
      return
    }

    // Marked only now, at the end of the walk. A server that restarts partway through
    // starts the pass again rather than calling a library backfilled that is not: a
    // second look at an asset costs one hash read and changes nothing, while a skipped
    // one keeps its null content_hash for good.
    await markDone(deps.db, DONE_KEY)
  })
}

/**
 * Assets with no `content_hash` yet, in id order from `after`.
 *
 * No `deletedAt` filter, unlike the face jobs: a trashed asset is still a duplicate of
 * whatever new upload arrives, so leaving it out would let the exact copy dedup is meant
 * to catch slip through. A row whose hash comes back null (unsupported container) is left
 * null and not revisited within this pass — paging by id past it is enough, and this
 * query would otherwise reselect it on every batch.
 */
function pendingContentHash(db: Database, limit: number, after: string | null) {
  return db
    .select({ id: assets.id, originalPath: assets.originalPath })
    .from(assets)
    .where(and(isNull(assets.contentHash), after ? gt(assets.id, after) : undefined))
    .orderBy(assets.id)
    .limit(limit)
}

/**
 * Queues the content-hash backfill, once per server. Called at boot.
 *
 * Every new upload fills the column itself, so there is nothing left to do once a pass
 * has reached the end of the library that predates it.
 */
export async function scheduleContentHashBackfill(queue: JobQueue, db: Database): Promise<boolean> {
  if (await isDone(db, DONE_KEY)) return false

  await queue.enqueue(CONTENT_HASH_BACKFILL_JOB, {})
  return true
}
