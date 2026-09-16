import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { SettingsService } from '../admin/settings.ts'
import { SessionService } from '../auth/sessions.ts'
import type { Database } from '../db/index.ts'
import { assetFiles, assets, jobs, users } from '../db/schema.ts'
import { LocalStorage } from '../media/storage.ts'
import { createTestConfig, createTestDatabase, removeTestConfig } from '../test/harness.ts'
import {
  type MaintenanceDeps,
  PRUNE_JOBS_JOB,
  PRUNE_UPLOADS_JOB,
  registerMaintenanceJobs,
  runMaintenanceTick,
  SWEEP_TRASH_JOB,
  startMaintenance,
  sweepTrash,
} from './maintenance.ts'
import { JobQueue } from './queue.ts'

const harness = await createTestDatabase()
const db: Database = harness.db
const config = createTestConfig()

afterAll(async () => {
  await harness.close()
  removeTestConfig(config)
})

beforeEach(async () => {
  await db.execute(sql`truncate users cascade`)
})

/** Lets a test act in the window the sweep opens between selecting a batch and reaching a row. */
class HookedStorage extends LocalStorage {
  onRemove: ((path: string) => Promise<void>) | null = null

  override async remove(path: string): Promise<void> {
    await this.onRemove?.(path)
    await super.remove(path)
  }
}

function makeDeps(): MaintenanceDeps & { library: HookedStorage; recounted: string[] } {
  const library = new HookedStorage(config.libraryDir)
  const recounted: string[] = []
  return {
    db,
    config,
    library,
    thumbnails: new LocalStorage(config.thumbsDir),
    sessions: new SessionService(db),
    settings: new SettingsService(db, { allowSignup: true, trashRetentionDays: 30 }),
    recounted,
    faces: {
      refreshFor: async (ownerId: string) => {
        recounted.push(ownerId)
      },
    },
  }
}

const DAY = 24 * 60 * 60 * 1000

async function makeUser(usedBytes: number) {
  const [row] = await db
    .insert(users)
    .values({ email: `${crypto.randomUUID()}@example.com`, name: 'Owner', usedBytes })
    .returning()
  return row!
}

/** A trashed asset with one original on disk. `daysAgo` is how long it has been in the trash. */
async function makeTrashedAsset(ownerId: string, daysAgo: number, sizeBytes: number) {
  const path = `${crypto.randomUUID()}.jpg`
  const [asset] = await db
    .insert(assets)
    .values({
      ownerId,
      type: 'image',
      originalFilename: 'photo.jpg',
      mimeType: 'image/jpeg',
      checksum: crypto.randomUUID(),
      sizeBytes,
      originalPath: path,
      capturedAt: new Date(),
      deletedAt: new Date(Date.now() - daysAgo * DAY),
    })
    .returning()
  await db.insert(assetFiles).values({
    assetId: asset!.id,
    variant: 'original',
    path,
    mimeType: 'image/jpeg',
    sizeBytes,
  })
  return asset!
}

const exists = (deps: MaintenanceDeps, path: string) => deps.library.exists(path)

async function restore(id: string) {
  await db.update(assets).set({ deletedAt: null }).where(eq(assets.id, id))
}

/**
 * Wraps a drizzle query builder so `before` runs at the moment the chain is awaited,
 * rather than when it is built: the statement has to be the next thing that happens.
 */
function runBefore<T extends object>(builder: T, before: () => Promise<void>): T {
  return new Proxy(builder, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown
      if (typeof value !== 'function') return value
      const method = value as (...args: unknown[]) => unknown
      if (prop === 'then') {
        return (onFulfilled?: unknown, onRejected?: unknown) =>
          before()
            .then(() => method.call(target) as Promise<unknown>)
            .then(onFulfilled as never, onRejected as never)
      }
      return (...args: unknown[]) => {
        const next = method.apply(target, args)
        return next && typeof next === 'object' ? runBefore(next, before) : next
      }
    },
  })
}

/**
 * A database that restores `id` in the instant before the sweep's guarded delete runs —
 * the one window the sweep cannot close, because the row is doomed when it is read and
 * live by the time it dies. Nothing the sweep destroys before that point can be undone.
 */
function restoringBeforeDelete(id: string): Database {
  let done = false
  const before = async () => {
    if (done) return
    done = true
    await restore(id)
  }
  return new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown
      if (prop !== 'delete' || typeof value !== 'function') return value
      const method = value as (...args: unknown[]) => object
      return (...args: unknown[]) => runBefore(method.apply(target, args), before)
    },
  }) as Database
}

const assetById = async (id: string) => (await db.select().from(assets).where(eq(assets.id, id)))[0]
const usedBytesOf = async (id: string) =>
  (await db.select().from(users).where(eq(users.id, id)))[0]!.usedBytes

describe('sweepTrash', () => {
  test('destroys an asset past the retention window', async () => {
    const owner = await makeUser(1000)
    const doomed = await makeTrashedAsset(owner.id, 31, 400)
    const deps = makeDeps()
    await deps.library.write(doomed.originalPath, 'bytes')

    expect(await sweepTrash(deps)).toBe(1)

    expect(await assetById(doomed.id)).toBeUndefined()
    expect(await exists(deps, doomed.originalPath)).toBe(false)
    expect(await usedBytesOf(owner.id)).toBe(600)
  })

  /**
   * Trashing a photograph spares a person whose faces are only on it — deleting them
   * would detach those faces for good, and a restore would bring the face back belonging
   * to nobody. Destroying the photograph removes that reason, and nothing else would
   * notice, so the sweep is what finally clears them. Once per owner: it takes 500
   * photographs at a time and each recount takes that owner's exclusive lock.
   */
  test('recounts each owner it destroyed a photograph for, exactly once', async () => {
    const owner = await makeUser(1000)
    const other = await makeUser(1000)
    const deps = makeDeps()
    for (const asset of [
      await makeTrashedAsset(owner.id, 31, 100),
      await makeTrashedAsset(owner.id, 33, 100),
      await makeTrashedAsset(other.id, 32, 100),
    ]) {
      await deps.library.write(asset.originalPath, 'bytes')
    }

    expect(await sweepTrash(deps)).toBe(3)

    expect(deps.recounted.toSorted()).toEqual([owner.id, other.id].toSorted())
  })

  /**
   * The deletions have already committed by the time the recount runs, and it takes the
   * owner's advisory lock — the one this codebase has watched time out under an import.
   * A failure there must not strand the owners behind it or report a sweep that worked
   * as a failure.
   */
  test('finishes the sweep when an owner’s recount fails', async () => {
    const owner = await makeUser(1000)
    const other = await makeUser(1000)
    const deps = makeDeps()
    for (const asset of [
      await makeTrashedAsset(owner.id, 33, 100),
      await makeTrashedAsset(other.id, 31, 100),
    ]) {
      await deps.library.write(asset.originalPath, 'bytes')
    }
    const failing = {
      ...deps,
      faces: {
        refreshFor: async (ownerId: string) => {
          deps.recounted.push(ownerId)
          if (ownerId === owner.id) throw new Error('canceling statement due to lock timeout')
        },
      },
    }

    expect(await sweepTrash(failing)).toBe(2)

    expect(deps.recounted.toSorted()).toEqual([owner.id, other.id].toSorted())
  })

  test('recounts nobody when it destroyed nothing', async () => {
    const owner = await makeUser(1000)
    const recent = await makeTrashedAsset(owner.id, 3, 400)
    const deps = makeDeps()
    await deps.library.write(recent.originalPath, 'bytes')

    expect(await sweepTrash(deps)).toBe(0)

    expect(deps.recounted).toBeEmpty()
  })

  test('leaves an asset still inside the retention window alone', async () => {
    const owner = await makeUser(1000)
    const recent = await makeTrashedAsset(owner.id, 3, 400)
    const deps = makeDeps()
    await deps.library.write(recent.originalPath, 'bytes')

    expect(await sweepTrash(deps)).toBe(0)

    expect(await assetById(recent.id)).toBeDefined()
    expect(await exists(deps, recent.originalPath)).toBe(true)
    expect(await usedBytesOf(owner.id)).toBe(1000)
  })

  // The batch select is a snapshot. Since #64 an upload of a trashed photograph restores
  // it, so a restore lands in this window without anybody clicking anything.
  test('skips an asset restored after the batch was selected', async () => {
    const owner = await makeUser(1000)
    const doomed = await makeTrashedAsset(owner.id, 40, 400)
    const rescued = await makeTrashedAsset(owner.id, 31, 100)
    const deps = makeDeps()
    await deps.library.write(doomed.originalPath, 'bytes')
    await deps.library.write(rescued.originalPath, 'bytes')

    // Oldest-first, so this fires while the sweep is on `doomed` and before it reaches
    // `rescued` — the restore the batch select could not have seen.
    deps.library.onRemove = async () => {
      deps.library.onRemove = null
      await restore(rescued.id)
    }

    expect(await sweepTrash(deps)).toBe(1)

    expect(await assetById(doomed.id)).toBeUndefined()
    const survivor = await assetById(rescued.id)
    expect(survivor).toBeDefined()
    expect(survivor!.deletedAt).toBeNull()
    expect(await exists(deps, rescued.originalPath)).toBe(true)
    expect(await usedBytesOf(owner.id)).toBe(600)
  })

  // The narrower half of the same race: the re-check passed, then the restore landed.
  // The row must survive, because its caller was told the photograph is live — and so
  // must its original. The upload that restored it answered `duplicate: true` and threw
  // away the bytes it was sent, so what is on disk here is the only copy in the world.
  test('keeps the row and its original when the restore lands after the re-check', async () => {
    const owner = await makeUser(1000)
    const rescued = await makeTrashedAsset(owner.id, 31, 400)
    const deps = makeDeps()
    await deps.library.write(rescued.originalPath, 'bytes')

    expect(await sweepTrash({ ...deps, db: restoringBeforeDelete(rescued.id) })).toBe(0)

    const survivor = await assetById(rescued.id)
    expect(survivor).toBeDefined()
    expect(survivor!.deletedAt).toBeNull()
    expect(await exists(deps, rescued.originalPath)).toBe(true)
    expect(await usedBytesOf(owner.id)).toBe(1000)
  })
})

/**
 * The cadence itself: #107 was that all three chores ran once, sixty seconds after boot,
 * and never again. What is asserted here is always what the queue holds — a timer that
 * fires proves nothing if no chore comes of it.
 */
describe('the maintenance cadence', () => {
  beforeEach(async () => {
    await db.execute(sql`truncate jobs`)
  })

  const makeQueue = () => new JobQueue(db, { concurrency: 1, idlePollMs: 5 })

  const chores = async (status?: 'queued' | 'running' | 'done' | 'failed') => {
    const rows = await db.select({ name: jobs.name, status: jobs.status }).from(jobs)
    return rows.filter((row) => !status || row.status === status).map((row) => row.name)
  }

  /** Re-runs the queue past the backoff a failed job earns, which a test cannot wait out. */
  async function drainIgnoringBackoff(queue: JobQueue, rounds: number) {
    for (let i = 0; i < rounds; i++) {
      await db
        .update(jobs)
        .set({ runAt: new Date(Date.now() - 1000) })
        .where(eq(jobs.status, 'queued'))
      await queue.drain()
    }
  }

  async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await predicate()) return true
      await Bun.sleep(5)
    }
    return false
  }

  test('queues all three chores on a tick', async () => {
    const queue = makeQueue()

    await runMaintenanceTick(queue)

    expect((await chores('queued')).sort()).toEqual(
      [PRUNE_JOBS_JOB, PRUNE_UPLOADS_JOB, SWEEP_TRASH_JOB].sort(),
    )
  })

  // The defect itself. One sweep is not a sweep schedule.
  test('queues each chore again once the last one has finished', async () => {
    const queue = makeQueue()
    registerMaintenanceJobs(queue, makeDeps())

    await runMaintenanceTick(queue)
    await queue.drain()
    await runMaintenanceTick(queue)

    expect((await chores('queued')).sort()).toEqual(
      [PRUNE_JOBS_JOB, PRUNE_UPLOADS_JOB, SWEEP_TRASH_JOB].sort(),
    )
    expect(await chores('done')).toHaveLength(3)
  })

  // A sweep that fails once must not stop sweeping for ever, which is #107 in miniature.
  test('keeps sweeping after a sweep throws', async () => {
    const queue = makeQueue()
    queue.register(SWEEP_TRASH_JOB, async () => {
      throw new Error('the library went away')
    })

    await runMaintenanceTick(queue)
    await drainIgnoringBackoff(queue, 1)

    // Still owed: the queue's own retry is the next run, so the tick must not add a second.
    expect(await chores('queued')).toContain(SWEEP_TRASH_JOB)
    await runMaintenanceTick(queue)
    expect((await chores('queued')).filter((name) => name === SWEEP_TRASH_JOB)).toHaveLength(1)

    // And once it has spent every attempt and been given up on, the next tick starts over.
    await drainIgnoringBackoff(queue, 5)
    expect(await chores('failed')).toContain(SWEEP_TRASH_JOB)

    await runMaintenanceTick(queue)

    expect(await chores('queued')).toContain(SWEEP_TRASH_JOB)
  })

  test('adds nothing beside a chore that is still queued or in flight', async () => {
    const queue = makeQueue()
    await runMaintenanceTick(queue)
    await db
      .update(jobs)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(jobs.name, SWEEP_TRASH_JOB))

    await runMaintenanceTick(queue)

    expect(await chores()).toHaveLength(3)
  })

  /**
   * What rescues the rescuer. `reclaimStale` used to be reachable only from inside
   * `PRUNE_JOBS_JOB`, so a worker that died running that job stranded the one row able
   * to free it. The tick reclaims before it enqueues, and a timer cannot be stranded.
   */
  test('frees a chore a dead worker left running, without the queue’s help', async () => {
    const queue = makeQueue()
    await queue.enqueue(PRUNE_JOBS_JOB, {})
    await db
      .update(jobs)
      .set({ status: 'running', startedAt: new Date(Date.now() - 20 * 60_000) })
      .where(eq(jobs.name, PRUNE_JOBS_JOB))

    await runMaintenanceTick(queue)

    expect(await chores('running')).toHaveLength(0)
    expect((await chores('queued')).filter((name) => name === PRUNE_JOBS_JOB)).toHaveLength(1)
  })

  test('goes on ticking until it is stopped', async () => {
    const queue = makeQueue()
    registerMaintenanceJobs(queue, makeDeps())
    // Fast enough to watch, slow enough that the ticker and the drain below are not
    // fighting for the same advisory lock every millisecond.
    const schedule = startMaintenance(queue, { firstDelayMs: 5, intervalMs: 20 })

    try {
      expect(await waitFor(async () => (await chores('queued')).length === 3)).toBe(true)
      await queue.drain()
      expect(await waitFor(async () => (await chores('queued')).length === 3)).toBe(true)
    } finally {
      // Awaited: a tick still in flight would commit its chores after the drain below.
      await schedule.stop()
    }

    await queue.drain()
    await Bun.sleep(30)
    expect(await chores('queued')).toHaveLength(0)
  })
})
