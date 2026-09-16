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
    // Recovering stranded jobs used to happen here and now happens in the tick that
    // enqueues this one: a rescuer that runs inside the queue is a rescuer the queue can
    // strand. What is left is housekeeping, and losing an hour of it costs nothing.
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
  // Logged rather than discarded in silence: self-healing only heals if some later sweep
  // succeeds, and one that fails every hour leaves covers pointing at destroyed faces
  // with nothing anywhere to say so.
  for (const ownerId of sweptOwners) {
    await deps.faces.refreshFor(ownerId).catch((error: unknown) => {
      console.warn(`sweepTrash: recounting faces for ${ownerId} failed`, error)
    })
  }

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

/** How often the chores come round. */
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000

/** Long enough after boot that the chores do not compete with the work a restart brings. */
const FIRST_TICK_DELAY_MS = 60_000

export type MaintenanceSchedule = {
  /** Resolves once the cadence has stopped and any tick already running has finished. */
  stop: () => Promise<void>
}

/**
 * One turn of the maintenance cadence: recover, then ask for each chore.
 *
 * `reclaimStale` is called from here rather than from inside a job because a job that
 * rescues stranded jobs can itself be stranded — a worker dying inside it leaves the one
 * row able to free it `running` for ever, and nothing else ever calls it (#107). Out here
 * it is driven by a timer, and a timer cannot be stranded: whatever kills the process
 * that owns it is also what starts the process that replaces it.
 *
 * `enqueueUnique`, because a chore still queued or running is this chore — a slow sweep,
 * or one backing off after a failure, must not collect a copy for every hour it takes.
 * Nothing is lost when a tick declines: the tick is not a chain, so the next one asks
 * again, and a chore that has given up entirely is simply not pending any more.
 */
export async function runMaintenanceTick(queue: JobQueue): Promise<void> {
  await queue.reclaimStale()
  await queue.enqueueUnique(SWEEP_TRASH_JOB, {})
  await queue.enqueueUnique(PRUNE_UPLOADS_JOB, {})
  await queue.enqueueUnique(PRUNE_JOBS_JOB, {})
}

/**
 * Starts the cadence. Called once at boot; `stop` belongs to shutdown.
 *
 * A self-rescheduling timeout rather than an interval, so a tick that takes longer than
 * the period delays the next one instead of overlapping it. A tick that throws is logged
 * and the next one is scheduled regardless: the whole of #107 was chores that stopped
 * happening, and a cadence that a single bad hour can end is the same bug again.
 *
 * `stop` waits for a tick already under way, because cancelling the timer only prevents
 * the next one. A shutdown that did not wait would close the pool under a tick's open
 * transaction, and every restart unlucky enough to land on one would report a database
 * error that means nothing.
 */
export function startMaintenance(
  queue: JobQueue,
  options: { firstDelayMs?: number; intervalMs?: number } = {},
): MaintenanceSchedule {
  const intervalMs = options.intervalMs ?? MAINTENANCE_INTERVAL_MS
  let stopped = false
  let timer: ReturnType<typeof setTimeout>
  let inFlight: Promise<void> = Promise.resolve()

  async function tick(): Promise<void> {
    try {
      await runMaintenanceTick(queue)
    } catch (error) {
      console.error('maintenance tick failed', error)
    }
    if (!stopped) timer = setTimeout(run, intervalMs)
  }

  // Every scheduled tick goes through here, so `inFlight` always names the current one.
  function run(): void {
    inFlight = tick()
  }

  timer = setTimeout(run, options.firstDelayMs ?? FIRST_TICK_DELAY_MS)

  return {
    stop: async () => {
      stopped = true
      clearTimeout(timer)
      await inFlight
    },
  }
}
