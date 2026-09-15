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
    // A chain pages by id, so it is only resumable under the rule it started with. The
    // one event that changes the rule is the one that restarts the server, so a chain
    // left `{after: X}` by an upgrade is the ordinary case: resuming it would cover the
    // tail of the library and then record the new scheme as walked over a head it never
    // read. Start again from the beginning instead. A payload with no scheme is one this
    // build inherited from an older one, which is the same situation.
    const walking = typeof payload.scheme === 'number' ? payload.scheme : null
    const resumable = walking === CONTENT_HASH_SCHEME
    const after = resumable && typeof payload.after === 'string' ? payload.after : null
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
      await queue.enqueue(CONTENT_HASH_BACKFILL_JOB, {
        after: batch[batch.length - 1]!.id,
        scheme: CONTENT_HASH_SCHEME,
      })
      return
    }

    // Recorded only now, at the end of the walk, so a server that restarts partway
    // through starts the pass again rather than calling a library hashed that is not: a
    // second look at an asset costs one hash read and changes nothing, while a skipped
    // one keeps its stale content_hash until the scheme changes again. One chain reaching
    // the end therefore means the library has been walked, which holds only because the
    // scheduler below refuses to start a second one beside the first (#92).
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
 * to catch slip through.
 *
 * A row the hasher cannot answer for keeps whatever scheme it had, so paging by id is
 * what carries this pass past it — the query would otherwise reselect it on every batch.
 * It is read again by every future walk, which for an unsupported container is the point:
 * a later rule may know the format this one does not.
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

/**
 * What the library's walk record says.
 *
 * `scheme` is what the last completed walk covered. `seen` is the highest rule any
 * server has run against this library, which is the only way to notice a rollback: the
 * rows themselves cannot say, since a build can only read schemes it knows about.
 */
type WalkRecord = { scheme: number; seen: number }

async function readWalkRecord(db: Database): Promise<WalkRecord> {
  const [row] = await db.select().from(settings).where(eq(settings.key, SCHEME_KEY)).limit(1)
  // `value` is `json not null`, which still admits the JSON value null, so this reads the
  // row defensively rather than through it: a throw here happens at boot and takes the
  // server with it. Anything unreadable counts as no walk at all -- one needless pass is
  // the cheap mistake, and leaving stale hashes in place is the expensive one.
  const value: unknown = row?.value
  if (typeof value !== 'object' || value === null) return { scheme: 0, seen: 0 }

  const fields = value as Record<string, unknown>
  const scheme = typeof fields.scheme === 'number' ? fields.scheme : 0
  // The migration writes `{scheme}` alone, and so did the first build to record one.
  const seen = typeof fields.seen === 'number' ? fields.seen : scheme
  return { scheme, seen }
}

async function writeWalkRecord(db: Database, record: WalkRecord): Promise<void> {
  await db
    .insert(settings)
    .values({ key: SCHEME_KEY, value: record })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: record, updatedAt: new Date() },
    })
}

/** Records `scheme` as walked. Never lowers what is already there. */
async function markSchemeWalked(db: Database, scheme: number): Promise<void> {
  // A stale job left in the queue across a rollback finds no rows to hash and
  // "completes"; writing its own, older scheme over the library's would then look like
  // an ordinary walk rather than the rollback it is.
  const record = await readWalkRecord(db)
  if (record.scheme >= scheme) return

  await writeWalkRecord(db, { scheme, seen: Math.max(record.seen, scheme) })
}

/**
 * Records that a server hashing at `scheme` is about to take uploads, and answers with
 * the library's record as it now stands.
 *
 * The record is clamped down to `scheme` here, which is what makes a rollback survivable.
 * Every upload this build accepts is stamped with its own rule, so a library served by it
 * cannot be further along than it is, whatever a newer binary recorded before the
 * rollback. Leave the record high and the upgrade back reads its own scheme in it, walks
 * nothing, and every photograph uploaded in between keeps a superseded hash for good.
 */
async function noteServing(db: Database, scheme: number): Promise<WalkRecord> {
  const record = await readWalkRecord(db)
  const served = { scheme: Math.min(record.scheme, scheme), seen: Math.max(record.seen, scheme) }
  if (served.scheme !== record.scheme || served.seen !== record.seen) {
    await writeWalkRecord(db, served)
  }
  return served
}

/**
 * Queues the content-hash backfill, once per scheme. Called at boot.
 *
 * Every new upload fills the column under the current scheme itself, so there is nothing
 * left to do once a pass has reached the end of a library hashed under an older one.
 *
 * `enqueueUnique`, because a restart mid-walk leaves the chain's `{after}` job queued and
 * it resumes on its own. A fresh chain beside it would re-read every original a second
 * time, and whichever of the two reached a short batch first would record the scheme
 * while the other was still mid-library — the record is only honest while there is one
 * walk (#92).
 */
export async function scheduleContentHashBackfill(queue: JobQueue, db: Database): Promise<boolean> {
  const record = await noteServing(db, CONTENT_HASH_SCHEME)
  if (record.seen > CONTENT_HASH_SCHEME) {
    // A rollback to a binary older than the library. Rows stamped with a rule this build
    // does not have are not selectable by it, so they stay unmatched by anything it
    // hashes. Nothing here can mend that -- say so, rather than let dedup quietly stop
    // working until someone upgrades again.
    console.warn(
      `content hash: library has been hashed at scheme ${record.seen}, this server hashes at ${CONTENT_HASH_SCHEME}; photographs stored under the newer rule will not be recognised until it is upgraded again`,
    )
  }
  if (record.scheme >= CONTENT_HASH_SCHEME) return false

  return (
    (await queue.enqueueUnique(CONTENT_HASH_BACKFILL_JOB, { scheme: CONTENT_HASH_SCHEME })) !== null
  )
}
