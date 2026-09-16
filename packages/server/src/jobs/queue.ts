import { and, eq, inArray, lte, sql } from 'drizzle-orm'
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

/** How long a job may go without a heartbeat before it is taken for a corpse. */
const STALE_AFTER_MINUTES = 15

/** Comfortably inside the window above, so one missed beat is not a death. */
const HEARTBEAT_MS = 60_000

/**
 * The longest a job may claim to be alive.
 *
 * A heartbeat says the process is running, not that the job is getting anywhere: a fetch
 * with no timeout, or an ffmpeg that never exits, would defend its row for ever and no
 * reclaim could reach it -- #107 again, moved inside the heartbeat. Past this it stops
 * being believed and the stale window frees it a quarter of an hour later. Generous,
 * because the cost of being wrong here is running a job twice.
 */
const MAX_JOB_LIFETIME_MS = 6 * 60 * 60 * 1000

const RECLAIMED = 'Reclaimed: the worker stopped without finishing this job'

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
    const heartbeat = this.beat(job.id, job.attempts)
    try {
      await handler(job.payload)
      await this.db
        .update(jobs)
        .set({ status: 'done', finishedAt: new Date(), lastError: null })
        .where(eq(jobs.id, job.id))
    } catch (error) {
      await this.fail(job.id, describeError(error), job.attempts, job.max_attempts)
    } finally {
      clearInterval(heartbeat)
    }
  }

  /**
   * Keeps saying a job is alive for as long as it runs.
   *
   * `started_at` is stamped once, at claim, so on its own it dates the job rather than
   * its last sign of life — and `reclaimStale` recurs hourly now (#107), where it used to
   * run about once per boot. Without this, anything slower than the window (the 190 MB
   * model download, a 4K transcode) would be handed to a second worker while the first is
   * still inside it, which is exactly what the reclaim promises never to do.
   *
   * Matched on the attempt this worker claimed, not the row alone: `claim` counts up, so
   * a row that was reclaimed and taken by somebody else no longer answers to this beat.
   * Bounded, too, so a job that has hung rather than finished is eventually let go of.
   */
  private beat(id: string, attempt: number): ReturnType<typeof setInterval> {
    const every = this.options.heartbeatMs ?? HEARTBEAT_MS
    const believedUntil = Date.now() + (this.options.maxJobLifetimeMs ?? MAX_JOB_LIFETIME_MS)
    const timer: ReturnType<typeof setInterval> = setInterval(() => {
      if (Date.now() >= believedUntil) {
        clearInterval(timer)
        return
      }
      void this.db
        .update(jobs)
        .set({ startedAt: new Date() })
        .where(and(eq(jobs.id, id), eq(jobs.status, 'running'), eq(jobs.attempts, attempt)))
        // Swallowed: a missed beat costs nothing until the window runs out, and failing
        // the job because its liveness note did not land would be the worse answer.
        .catch((error: unknown) => {
          console.warn('job heartbeat failed:', describeError(error))
        })
    }, every)
    return timer
  }

  private async fail(id: string, message: string, attempts: number, maxAttempts: number) {
    if (attempts >= maxAttempts) {
      await this.db
        .update(jobs)
        .set({ status: 'failed', finishedAt: new Date(), lastError: message })
        .where(eq(jobs.id, id))
      return
    }
    // Exponential backoff, capped so a stuck job still retries within the hour.
    const delaySeconds = Math.min(2 ** attempts * 5, 3600)
    await this.db
      .update(jobs)
      .set({
        status: 'queued',
        lastError: message,
        runAt: new Date(Date.now() + delaySeconds * 1000),
      })
      .where(eq(jobs.id, id))
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
    const spent = sql`${jobs.attempts} >= ${jobs.maxAttempts}`
    const reclaimed = await this.db.execute(sql`
      update ${jobs}
      set status = case when ${spent} then 'failed' else 'queued' end,
          finished_at = case when ${spent} then now() else null end,
          last_error = ${RECLAIMED},
          started_at = null,
          run_at = now()
      where ${jobs.status} = 'running'
        and ${jobs.startedAt} < now() - ${olderThanMinutes} * interval '1 minute'
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
