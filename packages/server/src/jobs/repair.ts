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
 * Videos are out: their pre-fix value came from ffprobe's `creation_time`, and nothing in
 * the container can settle it. A row an owner has corrected by hand is out for good.
 */
const captureTimeWhere = and(
  eq(assets.type, 'image'),
  eq(assets.capturedAtIsExact, true),
  sql`${assets.capturedAtOriginal} is null`,
)

/**
 * Images whose stored `exif.orientation` is null.
 *
 * A file whose camera wrote no Orientation tag stays a candidate for ever, because null
 * is also the right answer for it. That costs one EXIF read per pass and the pass is
 * started by hand, so there is nothing to bound it against.
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

/** How many rows a pass would examine, for the panel to show before anything is written. */
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
 * expiry whether or not they completed. So the only recoverable rows are those whose file
 * still carries an `OffsetTime*` tag; without one there is no way to place the wall clock,
 * and reading it as UTC — which is what is already stored — is the answer #50 settled on.
 */
function repairCaptureTime(row: AssetRow, tags: Record<string, unknown>): Update {
  const captured = exifCapturedAt(tags)
  if (!captured?.hasOffset) return null
  if (captured.at.getTime() === row.capturedAt.getTime()) return null

  // Re-derived alongside so the row stays self-consistent, though a file that named an
  // instant is exact by definition and every candidate was already flagged as one.
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
