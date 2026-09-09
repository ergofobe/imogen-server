import { and, eq, lte, sql } from 'drizzle-orm'
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

/** Long enough to outlast the slowest job, so a live one is never reclaimed under it. */
const STALE_AFTER_MINUTES = 15

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
    try {
      await handler(job.payload)
      await this.db
        .update(jobs)
        .set({ status: 'done', finishedAt: new Date(), lastError: null })
        .where(eq(jobs.id, job.id))
    } catch (error) {
      await this.fail(job.id, describeError(error), job.attempts, job.max_attempts)
    }
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
   * The window has to outlast the longest job rather than the shortest crash: a job still
   * legitimately running must never be handed to a second worker, which also keeps this
   * honest if the server is ever run as more than one replica.
   */
  async reclaimStale(olderThanMinutes = STALE_AFTER_MINUTES): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60_000)
    const spent = sql`${jobs.attempts} >= ${jobs.maxAttempts}`
    const reclaimed = await this.db.execute(sql`
      update ${jobs}
      set status = case when ${spent} then 'failed' else 'queued' end,
          finished_at = case when ${spent} then now() else null end,
          last_error = ${RECLAIMED},
          started_at = null,
          run_at = now()
      where ${jobs.status} = 'running' and ${jobs.startedAt} < ${cutoff}
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
