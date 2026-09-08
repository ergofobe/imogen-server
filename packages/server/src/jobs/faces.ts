import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { assets, faces } from '../db/schema.ts'
import type { FaceService } from '../faces/faces.ts'
import type { ModelStore } from '../faces/models.ts'
import { isDone, markDone } from './done.ts'
import type { JobQueue } from './queue.ts'

export const FACE_DETECT_JOB = 'faces.detect'
export const FACE_BACKFILL_JOB = 'faces.backfill'
export const FACE_MODELS_JOB = 'faces.downloadModels'
export const FACE_REPAIR_JOB = 'faces.repairStale'

/** Set once the repair pass below has walked the whole library. */
const REPAIR_DONE_KEY = 'faces.staleRepairDone'

/** How many photos one backfill pass queues before scheduling the next. */
const BACKFILL_BATCH = 200

/**
 * How many photos one repair pass re-checks before scheduling the next. Smaller than a
 * backfill batch because this one *runs* detection rather than queueing it: the batch is
 * the unit of work, not the unit of scheduling.
 */
const REPAIR_BATCH = 50

/** How long a photo waits between checks while the models are still downloading. */
const MODEL_WAIT_SECONDS = 30
/** About half an hour of waiting before a photo stops expecting the download to finish. */
const MODEL_WAIT_ATTEMPTS = 60

export type FaceJobDeps = {
  db: Database
  faces: FaceService
  models: ModelStore
  queue: JobQueue
}

export function registerFaceJobs(queue: JobQueue, deps: FaceJobDeps): void {
  queue.register(FACE_DETECT_JOB, async (payload) => {
    const assetId = payload.assetId
    if (typeof assetId !== 'string') throw new Error('face detection needs an assetId')

    // The models are fetched in the background when face grouping is switched on, so a
    // photo uploaded during that window reaches this job before they exist. It waits for
    // them rather than burning its attempts against a file that is still downloading.
    if (!(await deps.faces.modelsReady())) {
      const waited = typeof payload.waited === 'number' ? payload.waited : 0
      if (waited >= MODEL_WAIT_ATTEMPTS) {
        throw new Error(
          `face models are still missing after waiting; check the ${FACE_MODELS_JOB} job`,
        )
      }
      await queue.enqueue(
        FACE_DETECT_JOB,
        { assetId, waited: waited + 1 },
        { runAt: new Date(Date.now() + MODEL_WAIT_SECONDS * 1000) },
      )
      return
    }

    await deps.faces.processAsset(assetId)
  })

  queue.register(FACE_MODELS_JOB, async () => {
    await deps.models.download()
    // Once the models exist, scan whatever is already in the library.
    await queue.enqueue(FACE_BACKFILL_JOB, {})
  })

  /**
   * Walks the existing library in batches, queueing one detection per photo.
   *
   * Batched and self-rescheduling rather than one long job: a library of a hundred
   * thousand photos should make visible progress and survive a restart, not start again
   * from nothing.
   */
  queue.register(FACE_BACKFILL_JOB, async () => {
    if (!(await deps.faces.isEnabled())) return

    const pending = await unscannedAssets(deps.db, BACKFILL_BATCH)
    for (const asset of pending) {
      await queue.enqueue(FACE_DETECT_JOB, { assetId: asset.id })
    }
    if (pending.length === BACKFILL_BATCH) {
      await queue.enqueue(FACE_BACKFILL_JOB, {})
    }
  })

  /**
   * Walks the photographs that carry faces and asks each whether it still has any,
   * removing the ones that do not.
   *
   * A one-off for libraries that accumulated stale faces before `processAsset` learned to
   * clear them. Paged on asset id rather than an offset: the pass removes faces as it
   * goes, so an offset into "assets with faces" would shift underneath it and skip rows.
   */
  queue.register(FACE_REPAIR_JOB, async (payload) => {
    if (!(await deps.faces.isEnabled())) return
    if (!(await deps.faces.modelsReady())) return

    const after = typeof payload.after === 'string' ? payload.after : null
    const batch = await assetsWithFaces(deps.db, REPAIR_BATCH, after)
    for (const asset of batch) await deps.faces.recheckAsset(asset.id)

    if (batch.length === REPAIR_BATCH) {
      await queue.enqueue(FACE_REPAIR_JOB, { after: batch[batch.length - 1]!.id })
      return
    }

    // Marked only now, at the end of the walk. A server that restarts partway through
    // starts the pass again rather than calling a library repaired that is not: a second
    // look at a photograph costs one detection run and changes nothing, while a skipped
    // one keeps its stale faces for good.
    await markDone(deps.db, REPAIR_DONE_KEY)
  })
}

/**
 * Photos that have faces on record, in id order from `after`.
 *
 * Vaulted and trashed photos are left out for the same reason the backfill leaves them
 * out: this pass must not be the thing that opens them.
 */
export function assetsWithFaces(db: Database, limit: number, after: string | null) {
  return db
    .selectDistinct({ id: assets.id })
    .from(assets)
    .innerJoin(faces, eq(faces.assetId, assets.id))
    .where(
      and(
        eq(assets.type, 'image'),
        eq(assets.status, 'ready'),
        isNull(assets.deletedAt),
        isNull(assets.vaultedAt),
        after ? gt(assets.id, after) : undefined,
      ),
    )
    .orderBy(assets.id)
    .limit(limit)
}

/**
 * Queues the stale-face repair, once per server. Called at boot.
 *
 * Nothing re-scans a photograph whose `facesScannedAt` is stamped, so a library that lost
 * faces before the fix keeps them until something goes looking. There is no point looking
 * before face grouping is on and the models have arrived — a server that enables it later
 * picks the pass up at its next boot.
 */
export async function scheduleFaceRepair(
  queue: JobQueue,
  db: Database,
  faces: FaceService,
): Promise<boolean> {
  if (!(await faces.isEnabled())) return false
  if (!(await faces.modelsReady())) return false

  if (await isDone(db, REPAIR_DONE_KEY)) return false

  await queue.enqueue(FACE_REPAIR_JOB, {})
  return true
}

/**
 * Photos that have never been looked at.
 *
 * Keyed on `facesScannedAt` rather than "has no faces row": a landscape with nobody in
 * it produces no faces, and inferring from their absence would queue every such photo
 * on every pass, for ever. Vaulted and trashed photos are excluded here as well as in
 * the scan itself, so a backfill cannot be the thing that indexes them.
 */
export function unscannedAssets(db: Database, limit: number) {
  return db
    .select({ id: assets.id })
    .from(assets)
    .where(
      and(
        eq(assets.type, 'image'),
        eq(assets.status, 'ready'),
        isNull(assets.deletedAt),
        isNull(assets.vaultedAt),
        isNull(assets.facesScannedAt),
      ),
    )
    .limit(limit)
}

export async function countUnscanned(db: Database): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(assets)
    .where(
      and(
        eq(assets.type, 'image'),
        eq(assets.status, 'ready'),
        isNull(assets.deletedAt),
        isNull(assets.vaultedAt),
        isNull(assets.facesScannedAt),
      ),
    )
  return Number(row?.count ?? 0)
}
