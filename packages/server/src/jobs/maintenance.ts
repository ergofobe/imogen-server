import { and, eq, isNotNull, lte, sql } from 'drizzle-orm'
import type { SettingsService } from '../admin/settings.ts'
import type { SessionService } from '../auth/sessions.ts'
import type { Database } from '../db/index.ts'
import { assetFiles, assets, uploadSessions, users } from '../db/schema.ts'
import type { FaceService } from '../faces/faces.ts'
import type { Config } from '../lib/config.ts'
import type { LocalStorage } from '../media/storage.ts'
import type { JobQueue } from './queue.ts'

export const SWEEP_TRASH_JOB = 'maintenance.sweepTrash'
export const PRUNE_UPLOADS_JOB = 'maintenance.pruneUploads'
export const PRUNE_JOBS_JOB = 'maintenance.pruneJobs'

export type MaintenanceDeps = {
  db: Database
  config: Config
  library: LocalStorage
  thumbnails: LocalStorage
  sessions: SessionService
  settings: SettingsService
  faces: Pick<FaceService, 'refreshFor'>
}

export function registerMaintenanceJobs(queue: JobQueue, deps: MaintenanceDeps): void {
  queue.register(SWEEP_TRASH_JOB, async () => {
    await sweepTrash(deps)
  })
  queue.register(PRUNE_UPLOADS_JOB, async () => {
    await pruneUploads(deps)
  })
  queue.register(PRUNE_JOBS_JOB, async () => {
    // Before pruning, not after: a job a dead worker stranded is work to recover.
    await queue.reclaimStale()
    await queue.pruneCompleted(7)
    await deps.sessions.pruneExpired()
  })
}

/**
 * Permanently removes assets that have been in the trash past the retention window.
 *
 * The row goes first, and its files only once the delete has actually claimed it. A
 * restore can land at any point here, and whichever side of it the sweep is caught on,
 * one of the two failures follows: bytes with no row, or a row with no bytes. `assetFiles`
 * holds the `original` — the photograph itself, not a derivative — so a row with no bytes
 * is the destruction of the only copy, while bytes with no row is disk nobody reclaims.
 * Losing disk is recoverable and losing the photograph is not, so the delete leads.
 *
 * Returns how many assets it actually destroyed, which is not the size of the batch it
 * picked: a row restored while the batch is in progress is left where it is.
 */
export async function sweepTrash(deps: MaintenanceDeps): Promise<number> {
  const retentionDays = await deps.settings.trashRetentionDays()
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
  /** What makes a row doomed. Asked of the batch, then again of each row before it dies. */
  const isDoomed = (id: string) =>
    and(eq(assets.id, id), isNotNull(assets.deletedAt), lte(assets.deletedAt, cutoff))

  // Oldest first: the batch is capped, so without an order a large trash could keep
  // re-picking the same rows and starve the ones behind them.
  const doomed = await deps.db
    .select({ id: assets.id, ownerId: assets.ownerId, sizeBytes: assets.sizeBytes })
    .from(assets)
    .where(and(isNotNull(assets.deletedAt), lte(assets.deletedAt, cutoff)))
    .orderBy(assets.deletedAt)
    .limit(500)

  let swept = 0
  const sweptOwners = new Set<string>()

  for (const asset of doomed) {
    // The batch above is a snapshot, and a restore can land while an earlier row is
    // still being swept — since #64 an upload of a trashed photograph restores it, so
    // that happens without anybody clicking anything. This asks again to skip the work
    // for a row that has plainly come back; the guard on the delete below is the one
    // that decides, because only it and the restore contend for the same row.
    const [stillDoomed] = await deps.db
      .select({ id: assets.id })
      .from(assets)
      .where(isDoomed(asset.id))
      .limit(1)
    if (!stillDoomed) continue

    // Read the paths before the delete, which cascades these rows away with the asset.
    const files = await deps.db.select().from(assetFiles).where(eq(assetFiles.assetId, asset.id))

    const [deleted] = await deps.db
      .delete(assets)
      .where(isDoomed(asset.id))
      .returning({ id: assets.id })
    // Restored between the re-check and here: the row stays, its caller was told the
    // photograph is live, and nothing has been removed from disk yet to contradict that.
    if (!deleted) continue

    swept += 1
    sweptOwners.add(asset.ownerId)
    await deps.db
      .update(users)
      .set({ usedBytes: sql`greatest(${users.usedBytes} - ${asset.sizeBytes}, 0)` })
      .where(eq(users.id, asset.ownerId))

    // The row is gone, so nothing can reach these paths any more and no restore can
    // resurrect them. A crash before this finishes strands the bytes, which is the
    // failure the ordering is chosen to prefer.
    for (const file of files) {
      const store = file.variant === 'original' ? deps.library : deps.thumbnails
      await store.remove(file.path).catch(() => {})
    }
  }

  // Destroying the row cascades its faces away, and a person can be left with none at
  // all. This is the only moment that shows: trashing a photograph deliberately spares a
  // person whose faces are merely out of sight, because deleting them would detach those
  // faces for good and a restore would bring them back belonging to nobody. Once the
  // photograph itself is gone there is nothing left to restore, so here they really do
  // stop being a person. Once per owner, not per photograph — the sweep takes 500 at a
  // time and each recount takes that owner's exclusive lock.
  //
  // Swallowed per owner, because by now every deletion has committed. That lock is the
  // one this codebase has watched time out under an import, and letting it fail the job
  // would strand the owners behind it, skip `removeEmptyTombstones`, and report a sweep
  // that in fact succeeded. The work is pure bookkeeping and self-healing: the next
  // sweep, or any trash or restore, recounts the same owner.
  for (const ownerId of sweptOwners) await deps.faces.refreshFor(ownerId).catch(() => {})

  await removeEmptyTombstones(deps)

  return swept
}

/**
 * Drops deleted accounts once the last of their photographs has gone.
 *
 * Deleting an account leaves the row behind on purpose — assets cascade from it, so
 * removing it at the time would destroy the very photographs the trash is holding.
 * Once the sweep above has cleared them there is nothing left to protect.
 */
async function removeEmptyTombstones(deps: MaintenanceDeps): Promise<void> {
  await deps.db.execute(sql`
    delete from users
    where deleted_at is not null
      and not exists (select 1 from assets where assets.owner_id = users.id)
  `)
}

/** Drops abandoned resumable uploads and the partial files they were writing. */
export async function pruneUploads(deps: MaintenanceDeps): Promise<number> {
  const stale = await deps.db
    .select()
    .from(uploadSessions)
    .where(lte(uploadSessions.expiresAt, new Date()))
    .limit(500)

  for (const session of stale) {
    await Bun.file(session.tempPath)
      .delete()
      .catch(() => {})
    await deps.db.delete(uploadSessions).where(eq(uploadSessions.id, session.id))
  }
  return stale.length
}

/** Queues the recurring chores. Called once at boot. */
export async function scheduleMaintenance(queue: JobQueue): Promise<void> {
  const hourly = new Date(Date.now() + 60_000)
  await queue.enqueue(SWEEP_TRASH_JOB, {}, { runAt: hourly })
  await queue.enqueue(PRUNE_UPLOADS_JOB, {}, { runAt: hourly })
  await queue.enqueue(PRUNE_JOBS_JOB, {}, { runAt: hourly })
}
