import type { ExifData } from '@imogen/shared'
import { and, count, eq, gt, sql } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { assets } from '../db/schema.ts'
import { exifCapturedAt, exifOrientation, readExifTags } from '../media/pipeline.ts'
import type { StorageDriver } from '../media/storage.ts'
import { isDone, markDone } from './done.ts'
import type { JobQueue } from './queue.ts'

export const CAPTURE_TIME_REPAIR_JOB = 'repair.captureTime'
export const ORIENTATION_REPAIR_JOB = 'repair.exifOrientation'

/**
 * How many assets one pass re-reads before scheduling the next.
 *
 * Smaller than the content-hash backfill's batch because this one opens each file with
 * exifr rather than streaming it: the batch is the unit of work, not of scheduling.
 */
export const REPAIR_BATCH = 25

export type RepairName = 'captureTime' | 'exifOrientation'

export type RepairJobDeps = {
  db: Database
  /** Originals. Read only: a repair never rewrites the file it learns from. */
  storage: StorageDriver
  queue: JobQueue
}

/** One row of a pass, and everything the admin panel needs to describe it. */
type Repair = {
  job: string
  doneKey: string
  title: string
  description: string
  /** The rows the pass will examine. Not all of them can be repaired; see the notes below. */
  candidates: (db: Database, limit: number, after: string | null) => Promise<{ id: string }[]>
  where: ReturnType<typeof and>
  /** What one row becomes, given its file's tags, or `null` when it needs no change. */
  repair: (row: AssetRow, tags: Record<string, unknown>) => Update
}

type AssetRow = typeof assets.$inferSelect

/** The columns a repair writes, or `null` when the row is already right. */
type Update = Partial<typeof assets.$inferInsert> | null

/**
 * Assets whose stored capture time may be the zone-less EXIF wall clock #50 replaced.
 *
 * `captured_at_from_client` cannot narrow this: it is false for every pre-fix row *and*
 * for post-fix rows that legitimately had no client timestamp. Bounding on `created_at`
 * against a deploy date would need a date this code cannot know, so the pass re-checks
 * everything instead and is a no-op on a row that is already right.
 *
 * Deliberately wider than the `captured_at_is_exact = true` set #54 first named, because
 * that column is narrower than the defect. It was written by the *old* reader, so a file
 * whose date tag that reader could not make sense of reads `false` here even when today's
 * `exifInstant` handles it — offset and all. Those rows fell through to a client timestamp
 * or a file mtime and are exactly the defect, so the pass opens them too. Widening costs
 * nothing in safety: `repairCaptureTime` acts only on a file that names an instant *with*
 * an offset, and leaves every other row untouched however it got into the set.
 *
 * Videos are out: their pre-fix value came from ffprobe's `creation_time`, and nothing in
 * the container can settle it. A row an owner has corrected by hand is out for good.
 *
 * Trashed and vaulted photographs are deliberately left in, unlike the face passes. Theirs
 * is a scan that creates faces and people, so it must not be the thing that surfaces a
 * hidden photograph; this one reads a file and writes one column, and shows nobody
 * anything. Leaving them out would strand a wrong date in the owner's own vault timeline
 * with no other way to fix it, and a photograph waiting in the trash is one restore away
 * from the timeline it would be wrong in.
 */
const captureTimeWhere = and(eq(assets.type, 'image'), sql`${assets.capturedAtOriginal} is null`)

/**
 * Images whose stored `exif.orientation` is null.
 *
 * A file whose camera wrote no Orientation tag stays a candidate for ever, because null
 * is also the right answer for it. That costs one EXIF read per pass and the pass is
 * started by hand, so there is nothing to bound it against.
 *
 * Trashed and vaulted rows are in, for the reason given above.
 */
const orientationWhere = and(
  eq(assets.type, 'image'),
  // Parenthesised: `and` joins these with no brackets of its own, so a bare `or` here
  // would bind looser than the image check and sweep in every video with no exif.
  sql`(${assets.exif} is null or ${assets.exif}->>'orientation' is null)`,
)

export const REPAIRS: Record<RepairName, Repair> = {
  captureTime: {
    job: CAPTURE_TIME_REPAIR_JOB,
    doneKey: 'repair.captureTimeDone',
    title: 'Capture times stored without their EXIF offset',
    description:
      'Re-reads each photograph and moves its capture time only when the file carries an ' +
      'EXIF offset. The timestamp the uploading device sent was overwritten in place and ' +
      'is gone, so a file that names no offset cannot be repaired and is left alone, as is ' +
      'any date an owner has corrected by hand. Videos are not examined.',
    candidates: (db, limit, after) => page(db, captureTimeWhere, limit, after),
    where: captureTimeWhere,
    repair: repairCaptureTime,
  },
  exifOrientation: {
    job: ORIENTATION_REPAIR_JOB,
    doneKey: 'repair.exifOrientationDone',
    title: 'Missing exif.orientation',
    description:
      'Re-reads the Orientation tag, which was dropped for every photograph ingested ' +
      'before it was parsed correctly. The original file is never rewritten, so nothing ' +
      'here is lost or guessed at: it is a pure re-read of a tag still on disk. Only the ' +
      'orientation is rewritten; every other EXIF field is left as it was.',
    candidates: (db, limit, after) => page(db, orientationWhere, limit, after),
    where: orientationWhere,
    repair: repairOrientation,
  },
}

export function isRepairName(value: string): value is RepairName {
  // `in` walks the prototype chain, so `toString` and `constructor` would pass it and the
  // route would answer 500 where an unknown name has to answer 404.
  return Object.hasOwn(REPAIRS, value)
}

/**
 * How many rows a pass would examine, for the panel to show before anything is written.
 *
 * Only the orientation count falls as its walk proceeds. A repaired capture time still
 * satisfies its own predicate — that is what makes the pass idempotent and what lets it
 * re-check a library it has already walked — so that number is a size, not a progress bar.
 * Progress shows in the queue above it.
 */
export async function countRepairCandidates(db: Database, name: RepairName): Promise<number> {
  const [row] = await db.select({ n: count() }).from(assets).where(REPAIRS[name].where)
  return Number(row?.n ?? 0)
}

export async function repairIsDone(db: Database, name: RepairName): Promise<boolean> {
  return isDone(db, REPAIRS[name].doneKey)
}

/**
 * Registers the one-off repair passes.
 *
 * Deliberately not scheduled at boot, unlike the face and content-hash backfills beside
 * them. Those add something that was never there; these rewrite stored values across a
 * whole library with no undo, and an upgrade should not silently move every date in a
 * stranger's photographs. An administrator starts them from the Processing panel, which
 * shows the candidate count first.
 */
export function registerRepairJobs(queue: JobQueue, deps: RepairJobDeps): void {
  for (const name of Object.keys(REPAIRS) as RepairName[]) register(queue, deps, name)
}

function register(queue: JobQueue, deps: RepairJobDeps, name: RepairName): void {
  const { job, doneKey, candidates } = REPAIRS[name]

  /**
   * Paged on asset id rather than an offset, like the passes it is modelled on: the walk
   * changes the rows it selects, so an offset would shift underneath it and skip some.
   */
  queue.register(job, async (payload) => {
    const after = typeof payload.after === 'string' ? payload.after : null
    const batch = await candidates(deps.db, REPAIR_BATCH, after)

    for (const { id } of batch) await repairAsset(deps, id, name)

    if (batch.length === REPAIR_BATCH) {
      await queue.enqueue(job, { after: batch[batch.length - 1]!.id })
      return
    }

    // Marked only now, at the end of the walk. A server that restarts partway through
    // starts the pass again rather than calling a library repaired that is not: a second
    // look at a photograph costs one EXIF read and changes nothing, while a skipped one
    // keeps its wrong value for good.
    await markDone(deps.db, doneKey)
  })
}

/**
 * Re-reads one asset and writes what the file says, if anything.
 *
 * The pass's own predicate is re-asserted on both the read and the write, not left behind
 * in the batch query. The batch names twenty-five ids up front and each one is then opened
 * from disk in turn, so seconds pass between a row being chosen and being written. An owner
 * correcting a capture date through the API inside that window fills
 * `captured_at_original` — and an update keyed on the id alone would overwrite the
 * correction from the file moments later, which is the one irreversible thing this pass
 * promises never to do.
 */
export async function repairAsset(
  deps: RepairJobDeps,
  id: string,
  name: RepairName,
): Promise<void> {
  const { where, repair } = REPAIRS[name]

  const [row] = await deps.db
    .select()
    .from(assets)
    .where(and(eq(assets.id, id), where))
    .limit(1)
  // An upload that never finished has no file to learn from.
  if (!row || row.originalPath === '') return

  // A missing or unreadable original must not take the whole pass down with it: the rest
  // of the library still has something to gain from the walk finishing.
  const tags = await readExifTags(deps.storage.absolutePath(row.originalPath)).catch(() => null)
  if (!tags) return

  const update = repair(row, tags)
  if (!update) return

  await deps.db
    .update(assets)
    .set({ ...update, updatedAt: new Date() })
    .where(and(eq(assets.id, id), where))
}

/**
 * #54. Re-derives the instant a photograph was taken, and only when the file can name it.
 *
 * What this cannot do is restore what the uploading client sent: `ingest` wrote over
 * `captured_at` in place, `captured_at_original` is the owner-edit undo slot rather than a
 * record of it, there is no audit table, and `pruneUploads` clears `upload_sessions` on
 * expiry whether or not they completed. So the only rows this can put right are those whose
 * file still carries an `OffsetTime*` tag: that pair names an instant and needs nothing
 * guessed.
 *
 * A file that names no offset is left where it is, and that is a limit rather than a
 * verdict that the row is correct. Do not read the stored value as the UTC reading #50
 * settled on — it predates #50. The old pipeline let exifr revive the date tags, which
 * builds a Date in *the ingesting server's* timezone, so the row holds the wall clock
 * interpreted in whatever zone that machine ran in. On a server in UTC that happens to
 * equal today's reading; anywhere else it is out by that machine's offset, and nothing
 * recorded which machine or which offset. Rewriting these to the UTC reading would make
 * them reproducible and match what a fresh ingest stores today — but it would also move
 * every one of them on a claim about a zone this code cannot check, and #54 says to leave
 * them alone. That decision was taken on the understanding that they already held the UTC
 * reading, which is not so; it is worth revisiting there rather than here.
 */
function repairCaptureTime(row: AssetRow, tags: Record<string, unknown>): Update {
  const captured = exifCapturedAt(tags)
  if (!captured?.hasOffset) return null
  // Both halves, not just the instant: a row the walk now opens because its
  // `captured_at_is_exact` is false can already hold the right instant by way of a client
  // timestamp, and it still needs the label put right. Testing the instant alone is what
  // makes a second run a no-op, so the flag is tested with it rather than instead of it.
  if (captured.at.getTime() === row.capturedAt.getTime() && row.capturedAtIsExact) return null

  // Re-derived alongside so the row stays self-consistent: a file that names an instant is
  // exact by definition, whatever the old reader made of it.
  return { capturedAt: captured.at, capturedAtIsExact: true }
}

/** Every key `ExifData` requires, so a partial row still decodes for a client. */
const NO_EXIF: ExifData = {
  make: null,
  model: null,
  lens: null,
  fNumber: null,
  exposureTime: null,
  iso: null,
  focalLength: null,
  orientation: null,
}

/**
 * #57. Puts back the Orientation tag that was parsed into null for every earlier ingest.
 *
 * Only that one field is rewritten. The rest of the EXIF block was read correctly at
 * ingest, the search vector is built from `exif->>'make'` and `exif->>'model'`, and
 * re-deriving them here would be churn with a way to go wrong and nothing to gain.
 */
function repairOrientation(row: AssetRow, tags: Record<string, unknown>): Update {
  const orientation = exifOrientation(tags)
  if (orientation === null) return null

  return { exif: { ...NO_EXIF, ...(row.exif ?? {}), orientation } }
}

function page(db: Database, where: Repair['where'], limit: number, after: string | null) {
  return db
    .select({ id: assets.id })
    .from(assets)
    .where(and(where, after ? gt(assets.id, after) : undefined))
    .orderBy(assets.id)
    .limit(limit)
}
