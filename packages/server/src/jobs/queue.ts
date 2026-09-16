import { and, eq, inArray, lte, type SQL, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import type { Database } from '../db/index.ts'
import { jobs } from '../db/schema.ts'

export type JobHandler = (payload: Record<string, unknown>) => Promise<void>

function parsePayload(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return (value as Record<string, unknown>) ?? {}
}

export type QueueOptions = {
  concurrency: number
  /** How long to wait before asking for work again when the queue was empty. */
  idlePollMs?: number
  /** How often a running job touches `started_at` to show it is still alive. */
  heartbeatMs?: number
  /** The longest a job may go on saying so. */
  maxJobLifetimeMs?: number
}

/**
 * A Postgres-backed queue. A home lab should not need Redis to resize a thumbnail, and
 * `for update skip locked` gives us exactly the claim semantics a broker would.
 */
/**
 * Flattens an error and everything it wraps into one line.
 *
 * Drizzle reports a driver failure as a wrapper whose own message is nothing but the SQL
 * and its parameters; the deadlock, the constraint, the dropped connection all sit on
 * `cause`. Recording only `.message` is what left twenty failed face jobs in production
 * saying `Failed query: update "people" set face_count = ...` and naming nothing anyone
 * could act on — and by the time they were read, every other log that knew the answer had
 * rolled over. The driver's SQLSTATE comes along for the same reason.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)

  const chain: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current)
    const code = (current as { code?: unknown }).code
    chain.push(typeof code === 'string' ? `${current.message} [${code}]` : current.message)
    current = current.cause
  }
  // A cause is not obliged to be an Error; keep whatever it was rather than dropping it.
  if (current != null && !(current instanceof Error)) chain.push(String(current))

  return chain.join(': ')
}

/** For the message an operator reads in `last_error`, where milliseconds say nothing. */
function describeDuration(ms: number): string {
  if (ms < 60_000) return `${ms}ms`
  const minutes = Math.round(ms / 60_000)
  return minutes < 120 ? `${minutes} minutes` : `${Math.round(minutes / 60)} hours`
}

/** How long a job may go without a heartbeat before it is taken for a corpse. */
const STALE_AFTER_MINUTES = 15

/** Comfortably inside the window above, so one missed beat is not a death. */
const HEARTBEAT_MS = 60_000

/**
 * The longest a worker will wait for one job.
 *
 * A heartbeat says the process is running, not that the job is getting anywhere: a fetch
 * with no timeout, or an ffmpeg that never exits, would defend its row for ever and no
 * reclaim could reach it -- #107 again, moved inside the heartbeat. Past this the worker
 * stops waiting and the row is failed.
 *
 * Generous, because being wrong here is expensive in both directions and neither is
 * recoverable by the queue: too short and a slow job is killed off while it was working,
 * too long and a wedged one sits there for hours. Nothing retries it afterwards, so the
 * cost of being wrong is a job that waits for a person rather than one that runs twice --
 * which is the better failure now that the run it would be retried beside cannot be
 * stopped (#112).
 */
const MAX_JOB_LIFETIME_MS = 6 * 60 * 60 * 1000

const RECLAIMED = 'Reclaimed: the worker stopped without finishing this job'

/**
 * Why a worker stopped waiting for its handler, and whether the row is still its to say
 * so in. A job given away mid-flight is the second worker's business now.
 */
type Abandonment = { reason: string; ours: boolean }

export class JobQueue {
  private readonly handlers = new Map<string, JobHandler>()
  private workers: Promise<void>[] = []
  private running = false

  constructor(
    private readonly db: Database,
    private readonly options: QueueOptions,
  ) {}

  register(name: string, handler: JobHandler): void {
    this.handlers.set(name, handler)
  }

  async enqueue(
    name: string,
    payload: Record<string, unknown>,
    options: { runAt?: Date; maxAttempts?: number } = {},
  ): Promise<string> {
    const [row] = await this.db
      .insert(jobs)
      .values({
        name,
        payload,
        // The claim query compares against Postgres's clock, so Postgres must set the
        // default. The app's clock can run milliseconds ahead of the database's, which
        // would make a just-enqueued job briefly invisible to its own workers.
        runAt: options.runAt ?? sql`now()`,
        maxAttempts: options.maxAttempts ?? 5,
      })
      .returning({ id: jobs.id })
    return row!.id
  }

  /**
   * Enqueues unless a job of the same name is already waiting or in flight. Answers with
   * the new job's id, or null when one was already there.
   *
   * For the walks that schedule themselves at boot. A restart during one leaves its
   * `{after: X}` job `queued` -- `reclaimStale` only ever looks at `running` rows -- and
   * an unconditional boot-time enqueue put a fresh `{}` beside it. Both then ran, and the
   * fresh one re-ran the whole library from the start: hours of ONNX detection on every
   * restart that landed mid-walk (#92).
   *
   * The name is the whole of the identity, so a chain's own re-enqueue must not come
   * through here -- it runs while its own row is `running` and would refuse to continue.
   *
   * Under an advisory lock rather than a bare check-then-insert: the rows being counted
   * are ones that do not exist yet, so there is nothing to take a row lock on, and two
   * servers booting together would both read an empty queue.
   */
  async enqueueUnique(
    name: string,
    payload: Record<string, unknown>,
    options: { runAt?: Date; maxAttempts?: number } = {},
  ): Promise<string | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`jobs:enqueue:${name}`}))`)

      const [pending] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.name, name), inArray(jobs.status, ['queued', 'running'])))
        .limit(1)
      if (pending) return null

      const [row] = await tx
        .insert(jobs)
        .values({
          name,
          payload,
          runAt: options.runAt ?? sql`now()`,
          maxAttempts: options.maxAttempts ?? 5,
        })
        .returning({ id: jobs.id })
      return row!.id
    })
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.workers = Array.from({ length: this.options.concurrency }, () => this.loop())
  }

  async stop(): Promise<void> {
    this.running = false
    await Promise.allSettled(this.workers)
    this.workers = []
  }

  /** Runs queued work until the queue is empty. Used by tests, not by the server. */
  async drain(limit = 1000): Promise<number> {
    let processed = 0
    while (processed < limit) {
      const job = await this.claim()
      if (!job) break
      await this.run(job)
      processed++
    }
    return processed
  }

  private async loop(): Promise<void> {
    const idle = this.options.idlePollMs ?? 1000
    while (this.running) {
      try {
        const job = await this.claim()
        if (!job) {
          await Bun.sleep(idle)
          continue
        }
        await this.run(job)
      } catch (error) {
        // Flattened, for the same reason `fail` flattens: drizzle's own message is the
        // SQL and nothing else, and when the pool is the thing that is broken the answer
        // is on `cause`. A worker that cannot reach the database says so here roughly
        // once per backstop, which is how #71 stops being silent.
        console.error('job worker error:', describeError(error))
        await Bun.sleep(idle)
      }
    }
  }

  private async claim() {
    // One statement, so two workers can never take the same row.
    const claimed = await this.db.execute<{
      id: string
      name: string
      payload: Record<string, unknown>
      attempts: number
      max_attempts: number
    }>(sql`
      update ${jobs} set status = 'running', started_at = now(), attempts = ${jobs.attempts} + 1
      where ${jobs.id} = (
        select ${jobs.id} from ${jobs}
        where ${jobs.status} = 'queued' and ${jobs.runAt} <= now()
        order by ${jobs.runAt}
        for update skip locked
        limit 1
      )
      returning ${jobs.id}, ${jobs.name}, ${jobs.payload}, ${jobs.attempts}, ${jobs.maxAttempts}
    `)
    const rows = Array.isArray(claimed) ? claimed : (claimed as { rows?: unknown[] }).rows
    const row = rows?.[0] as
      | { id: string; name: string; payload: unknown; attempts: number; max_attempts: number }
      | undefined
    if (!row) return null

    // Raw SQL bypasses drizzle's column mappers, so jsonb arrives as text.
    return { ...row, payload: parsePayload(row.payload) }
  }

  private async run(job: {
    id: string
    name: string
    payload: Record<string, unknown>
    attempts: number
    max_attempts: number
  }): Promise<void> {
    const handler = this.handlers.get(job.name)
    if (!handler) {
      await this.fail(
        job.id,
        `No handler registered for "${job.name}"`,
        job.attempts,
        job.max_attempts,
      )
      return
    }
    const vigil = this.watch(job.id, job.attempts)
    try {
      // Settled rather than awaited: when the vigil wins the race below this promise
      // outlives the worker, and an orphan that rejects into nobody's `catch` reaches
      // `unhandledRejection`, which this server exits on.
      const settled = handler(job.payload).then(
        () => ({ threw: false }) as const,
        (error: unknown) => ({ threw: true, error }) as const,
      )
      const outcome = await Promise.race([settled, vigil.abandoned])
      // Before any of the writes below, not in the `finally` after them: a beat that
      // lands while one is in flight finds the row already `done` or `failed`, matches
      // nothing, and reports a job that was taken away when in fact it simply finished.
      // The signal is only worth having if it is never raised by an ordinary success.
      vigil.stop()

      if ('reason' in outcome) {
        // Abandonment is this worker leaving, and nothing more. A promise cannot be
        // cancelled, so the handler goes on until it returns or the process ends, still
        // holding its memory, its file handles and any child it spawned. What is
        // recovered is the worker, which is the part that was never coming back on its
        // own (#112).
        //
        // Failed rather than requeued, and this is the one place the queue gives up on a
        // job it could retry. Everywhere else a retry costs another run; here the run it
        // replaces is still going, because nothing could stop it -- five attempts at a
        // handler that hangs is five live copies of it, five ffmpeg children and five
        // copies of its memory, arrived at one every six hours. A job that has hung past
        // its whole lifetime is not a retry candidate: it is something for a person to
        // look at, which `last_error` now says plainly and the admin retry can restart.
        //
        // The queue not retrying it is not quite the same as it never running again: a
        // name that schedules itself -- the maintenance chores, the walks -- is pending
        // no longer once the row is `failed`, so the next tick asks for it and a fresh
        // copy does run beside the hung one. That is the trade `enqueueUnique` is for,
        // and the alternative is a chore that stops happening, which was #107.
        console.error(`job ${job.name} ${job.id}: ${outcome.reason}`)
        if (outcome.ours) {
          // Outside the handler's `catch`, which routes a failure into `fail` and would
          // requeue the very job this branch has just decided must not be retried. A row
          // that cannot be marked failed is left `running` with its beat stopped, which
          // is what a worker that died looks like, and the hourly reclaim knows that one.
          await this.writeAttempt('abandonment', job.id, job.attempts, {
            status: 'failed',
            finishedAt: new Date(),
            lastError: outcome.reason,
          }).catch((error: unknown) => {
            console.error('job abandonment could not be recorded:', describeError(error))
          })
        }
        return
      }
      if (outcome.threw) throw outcome.error

      await this.writeAttempt('completion', job.id, job.attempts, {
        status: 'done',
        finishedAt: new Date(),
        lastError: null,
      })
    } catch (error) {
      await this.fail(job.id, describeError(error), job.attempts, job.max_attempts)
    } finally {
      vigil.stop()
    }
  }

  /**
   * A write that belongs to one attempt of one job, and says whether it landed.
   *
   * Three things have to agree: the row, the attempt this worker claimed, and that the
   * row is still `running`. The attempt alone is not enough, because `reclaimStale`
   * requeues a row without touching its attempt count — so a worker returning after the
   * reclaim had let go of its job found the number it claimed under still sitting there,
   * and marked a queued job `done`.
   *
   * Zero rows is therefore not a nothing. It is the one clean signal that a job was taken
   * away while a worker was still inside it, and the scoping #108 added exists precisely
   * to handle that case — so discarding the signal made the case invisible.
   *
   * The three together are evidence of ownership rather than proof of it: the attempt
   * count only ever counts up in the queue itself, but an administrator retrying a job
   * rewinds it to zero, and a row that comes back round to the same number is
   * indistinguishable from the one this worker claimed (#115).
   */
  private async writeAttempt(
    what: string,
    id: string,
    attempt: number,
    values: PgUpdateSetSource<typeof jobs>,
  ): Promise<boolean> {
    const matched = await this.db
      .update(jobs)
      .set(values)
      .where(and(eq(jobs.id, id), eq(jobs.attempts, attempt), eq(jobs.status, 'running')))
      .returning({ id: jobs.id })
    if (matched.length > 0) return true

    console.warn(`job ${what} matched no row: ${id} attempt ${attempt} is no longer this worker's`)
    return false
  }

  /**
   * Keeps saying a job is alive for as long as it runs, and says when to stop waiting.
   *
   * `started_at` is stamped once, at claim, so on its own it dates the job rather than
   * its last sign of life — and `reclaimStale` recurs hourly now (#107), where it used to
   * run about once per boot. Without a beat, anything slower than the window (the 190 MB
   * model download, a 4K transcode) would be handed to a second worker while the first is
   * still inside it, which is exactly what the reclaim promises never to do.
   *
   * Two things end the vigil, and both hand the worker back rather than only the row:
   *
   * - the lifetime runs out, which says the handler has hung rather than finished;
   * - a beat matches no row, which says the job is somebody else's now.
   *
   * A `setTimeout` rather than a deadline compared against `Date.now()` on each beat: the
   * timer counts elapsed time, where the wall clock can step under an NTP correction or a
   * suspended VM and cut a perfectly healthy job short.
   */
  private watch(
    id: string,
    attempt: number,
  ): { abandoned: Promise<Abandonment>; stop: () => void } {
    const every = this.options.heartbeatMs ?? HEARTBEAT_MS
    const lifetime = this.options.maxJobLifetimeMs ?? MAX_JOB_LIFETIME_MS

    let abandon: (abandonment: Abandonment) => void = () => {}
    // Resolves, never rejects: it is raced against the handler, and a rejection here
    // would be reported as the job's own failure.
    const abandoned = new Promise<Abandonment>((resolve) => {
      abandon = resolve
    })

    const beat = setInterval(() => {
      // Postgres's clock, for the same reason the cutoff it is compared against is.
      void this.writeAttempt('heartbeat', id, attempt, { startedAt: sql`now()` }).then(
        (landed) => {
          // The row answers to somebody else now, so the worker has nothing left to say
          // about it: the beat above has already reported it gone, and a second write
          // that cannot match would only report it again.
          if (!landed) {
            abandon({ reason: 'Abandoned: this job was given to another worker', ours: false })
          }
        },
        // Swallowed: a missed beat costs nothing until the window runs out, and failing
        // the job because its liveness note did not land would be the worse answer. A
        // database that cannot be reached is not the same thing as a job that was taken
        // away, and only the second is worth giving up on.
        (error: unknown) => {
          console.warn('job heartbeat failed:', describeError(error))
        },
      )
    }, every)

    const deadline = setTimeout(() => {
      abandon({
        reason: `Abandoned: the handler was still running after ${describeDuration(lifetime)}`,
        ours: true,
      })
    }, lifetime)

    return {
      abandoned,
      stop: () => {
        clearInterval(beat)
        clearTimeout(deadline)
      },
    }
  }

  private async fail(id: string, message: string, attempts: number, maxAttempts: number) {
    if (attempts >= maxAttempts) {
      await this.writeAttempt('failure', id, attempts, {
        status: 'failed',
        finishedAt: new Date(),
        lastError: message,
      })
      return
    }
    // Exponential backoff, capped so a stuck job still retries within the hour.
    const delaySeconds = Math.min(2 ** attempts * 5, 3600)
    await this.writeAttempt('retry', id, attempts, {
      status: 'queued',
      lastError: message,
      // Postgres's clock: `claim` compares `run_at` against it, so an app clock running
      // behind the database's would make a job eligible before its backoff had elapsed —
      // the skew the comment on `enqueue` exists to prevent, arrived at from the retry
      // side instead of the insert side.
      runAt: sql`now() + ${delaySeconds} * interval '1 second'`,
    })
  }

  /**
   * Returns to the queue any job a worker died in the middle of.
   *
   * `claim` only ever looks at `queued`, so a row left `running` when the process went
   * away is never looked at again. Thirteen sat that way in production for eleven days,
   * and four of them were `asset.ingest` holding back 364 already-uploaded photos.
   *
   * A job out of attempts is failed rather than requeued. The crash may well be the job's
   * own doing — a photo that kills the process is reclaimed, retried, and kills it again —
   * and `claim` does not check the attempt limit, so requeuing forever would be a crash
   * loop wearing the costume of a recovery.
   *
   * The window is silence, not age: a running job says so every minute, so it measures
   * how long since the last sign of life. A job still legitimately working must never be
   * handed to a second worker, which also keeps this honest if the server is ever run as
   * more than one replica.
   *
   * The cutoff is Postgres's, because `started_at` is: `claim` stamps it with `now()`, and
   * an app clock running ahead of the database's would make a job that has just started
   * look like one that stopped.
   */
  async reclaimStale(olderThanMinutes = STALE_AFTER_MINUTES): Promise<number> {
    return this.reclaim(
      sql`and ${jobs.startedAt} < now() - ${olderThanMinutes} * interval '1 minute'`,
    )
  }

  /**
   * Everything the last process left running. For boot, and only for boot.
   *
   * `reclaimStale` measures silence, and since the heartbeat a crash leaves rows whose
   * last sign of life is under a minute old — so at boot, when every `running` row is by
   * definition a corpse, the fifteen-minute window matches none of them and recovery
   * waits for the first hourly tick to land fifteen minutes after the silence began
   * (#111). There is no silence to measure here: `start()` has not been called, so no
   * worker of this process can be inside any of these rows, and the premise is not that
   * they have been quiet but that they are dead.
   *
   * So no clock appears in this one at all, rather than a zero window: `started_at` is
   * compared against nothing, and a row cannot be missed for having been beaten on a
   * moment ago.
   *
   * That premise is one process, and it is the only thing here that assumes it — the
   * hourly `reclaimStale` measures silence precisely so that it does not. A second
   * instance booting would hand itself the first's live work, so this call belongs at
   * boot in a single-instance deployment and nowhere else. Which is what imogen is: one
   * container, one library directory on a local volume.
   */
  async reclaimAllRunning(): Promise<number> {
    return this.reclaim(sql.empty())
  }

  private async reclaim(silence: SQL): Promise<number> {
    const spent = sql`${jobs.attempts} >= ${jobs.maxAttempts}`
    const reclaimed = await this.db.execute(sql`
      update ${jobs}
      set status = case when ${spent} then 'failed' else 'queued' end,
          finished_at = case when ${spent} then now() else null end,
          last_error = ${RECLAIMED},
          started_at = null,
          run_at = now()
      where ${jobs.status} = 'running' ${silence}
      returning ${jobs.id}
    `)
    const rows = Array.isArray(reclaimed) ? reclaimed : (reclaimed as { rows?: unknown[] }).rows
    return rows?.length ?? 0
  }

  async pruneCompleted(olderThanDays = 7): Promise<void> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)
    await this.db.delete(jobs).where(and(eq(jobs.status, 'done'), lte(jobs.finishedAt, cutoff)))
  }
}
