import { and, eq, gt, isNull, lt, or } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { assets, settings } from '../db/schema.ts'
import { CONTENT_HASH_SCHEME, contentHash } from '../media/content-hash.ts'
import type { StorageDriver } from '../media/storage.ts'
import type { JobQueue } from './queue.ts'

export const CONTENT_HASH_BACKFILL_JOB = 'assets.contentHashBackfill'

/**
 * The scheme of the last walk that reached the end of the library.
 *
 * A version rather than the boolean this used to be. "Done" meant done for ever, so a
 * library that had been walked kept its old hashes through any later change to the
 * hashing rule and a re-upload of the same photograph no longer matched itself (#86).
 */
const SCHEME_KEY = 'assets.contentHashScheme'

/** How many assets one pass hashes before scheduling the next. */
const BATCH = 50

export type ContentHashJobDeps = {
  db: Database
  storage: StorageDriver
}

export function registerContentHashJobs(queue: JobQueue, deps: ContentHashJobDeps): void {
  /**
   * Walks assets whose `content_hash` predates the current scheme, hashing each from the
   * file on disk.
   *
   * Batched and self-rescheduling rather than one long job, same reasoning as the face
   * backfill: a large library should make visible progress and survive a restart rather
   * than start over from nothing. That matters more now that the walk runs again after
   * every rule change, and reads every original when it does.
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
      // Nothing is written when the hash comes back null. A row re-hashed under a new
      // scheme already holds an answer, and overwriting it with null because the file is
      // unreadable would lose the twins it still finds. The row keeps its old scheme and
      // this walk still finishes: an original that cannot be read is broken in a way a
      // hashing pass cannot mend, and blocking the record on it would re-read the whole
      // library at every boot for ever. It is picked up again at the next rule change.
      if (hash !== null) {
        await deps.db
          .update(assets)
          .set({ contentHash: hash, contentHashScheme: CONTENT_HASH_SCHEME })
          .where(eq(assets.id, asset.id))
      }
    }

    if (batch.length === BATCH) {
      await queue.enqueue(CONTENT_HASH_BACKFILL_JOB, { after: batch[batch.length - 1]!.id })
      return
    }

    // Recorded only now, at the end of the walk. A server that restarts partway through
    // starts the pass again rather than calling a library hashed that is not: a second
    // look at an asset costs one hash read and changes nothing, while a skipped one keeps
    // its stale content_hash until the scheme changes again.
    await markSchemeWalked(deps.db, CONTENT_HASH_SCHEME)
  })
}

/**
 * Assets not yet hashed under the current scheme, in id order from `after`.
 *
 * `content_hash_scheme` is null exactly when `content_hash` is, so the null arm is the
 * library that predates the hash and the `lt` arm is the library that predates the
 * current rule.
 *
 * No `deletedAt` filter, unlike the face jobs: a trashed asset is still a duplicate of
 * whatever new upload arrives, so leaving it out would let the exact copy dedup is meant
 * to catch slip through. A row the hasher cannot answer for (unsupported container,
 * unreadable file) keeps its scheme and is not revisited within this pass — paging by id
 * past it is enough, and this query would otherwise reselect it on every batch.
 */
function pendingContentHash(db: Database, limit: number, after: string | null) {
  return db
    .select({ id: assets.id, originalPath: assets.originalPath })
    .from(assets)
    .where(
      and(
        or(isNull(assets.contentHashScheme), lt(assets.contentHashScheme, CONTENT_HASH_SCHEME)),
        after ? gt(assets.id, after) : undefined,
      ),
    )
    .orderBy(assets.id)
    .limit(limit)
}

/** The scheme the last completed walk covered, or 0 if none has finished. */
async function walkedScheme(db: Database): Promise<number> {
  const [row] = await db.select().from(settings).where(eq(settings.key, SCHEME_KEY)).limit(1)
  // `value` is `json not null`, which still admits the JSON value null, so this reads the
  // row defensively rather than through it: a throw here happens at boot and takes the
  // server with it. Anything unreadable counts as no walk at all -- one needless pass is
  // the cheap mistake, and leaving stale hashes in place is the expensive one.
  const value: unknown = row?.value
  if (typeof value !== 'object' || value === null) return 0
  const scheme = (value as Record<string, unknown>).scheme
  return typeof scheme === 'number' ? scheme : 0
}

/** Records `scheme` as walked. Never lowers what is already there. */
async function markSchemeWalked(db: Database, scheme: number): Promise<void> {
  // A build older than the library would otherwise write its own scheme over a higher
  // one -- a stale job left in the queue across a rollback finds no rows to hash and
  // "completes" -- and silence the warning below that says dedup has stopped working.
  if ((await walkedScheme(db)) >= scheme) return

  await db
    .insert(settings)
    .values({ key: SCHEME_KEY, value: { scheme } })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: { scheme }, updatedAt: new Date() },
    })
}

/**
 * Queues the content-hash backfill, once per scheme. Called at boot.
 *
 * Every new upload fills the column under the current scheme itself, so there is nothing
 * left to do once a pass has reached the end of a library hashed under an older one.
 */
export async function scheduleContentHashBackfill(queue: JobQueue, db: Database): Promise<boolean> {
  const walked = await walkedScheme(db)
  if (walked > CONTENT_HASH_SCHEME) {
    // A rollback to a binary older than the library. Every row is stamped with a rule
    // this build does not have, so none is selectable and new uploads hash under the
    // older rule and match nothing stored. Nothing here can mend that -- say so, rather
    // than let dedup quietly stop working.
    console.warn(
      `content hash: library is at scheme ${walked}, this server hashes at ${CONTENT_HASH_SCHEME}; duplicate detection is off until it is upgraded again`,
    )
    return false
  }
  if (walked === CONTENT_HASH_SCHEME) return false

  await queue.enqueue(CONTENT_HASH_BACKFILL_JOB, {})
  return true
}
