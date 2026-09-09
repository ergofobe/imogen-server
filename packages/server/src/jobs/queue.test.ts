import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import type { Database } from '../db/index.ts'
import { jobs } from '../db/schema.ts'
import { createTestDatabase } from '../test/harness.ts'
import { JobQueue } from './queue.ts'

const harness = await createTestDatabase()
const db: Database = harness.db

afterAll(() => harness.close())

beforeEach(async () => {
  await db.execute(sql`truncate jobs`)
})

function makeQueue(concurrency = 1) {
  return new JobQueue(db, { concurrency, idlePollMs: 5 })
}

describe('running jobs', () => {
  test('runs a queued job and marks it done', async () => {
    const queue = makeQueue()
    const seen: string[] = []
    queue.register('greet', async (payload) => {
      seen.push(payload.name as string)
    })
    await queue.enqueue('greet', { name: 'imogen' })

    await queue.drain()

    expect(seen).toEqual(['imogen'])
    const [row] = await db.select().from(jobs)
    expect(row!.status).toBe('done')
  })

  test('runs jobs in run-at order', async () => {
    const queue = makeQueue()
    const order: number[] = []
    queue.register('note', async (p) => {
      order.push(p.n as number)
    })
    await queue.enqueue('note', { n: 2 }, { runAt: new Date(Date.now() - 1000) })
    await queue.enqueue('note', { n: 1 }, { runAt: new Date(Date.now() - 5000) })

    await queue.drain()

    expect(order).toEqual([1, 2])
  })

  test('leaves a future job alone', async () => {
    const queue = makeQueue()
    queue.register('later', async () => {})
    await queue.enqueue('later', {}, { runAt: new Date(Date.now() + 60_000) })

    expect(await queue.drain()).toBe(0)
    const [row] = await db.select().from(jobs)
    expect(row!.status).toBe('queued')
  })

  test('increments the attempt count when it runs', async () => {
    const queue = makeQueue()
    queue.register('once', async () => {})
    await queue.enqueue('once', {})

    await queue.drain()

    const [row] = await db.select().from(jobs)
    expect(row!.attempts).toBe(1)
  })
})

describe('failure handling', () => {
  test('requeues a failed job with a backoff instead of losing it', async () => {
    const queue = makeQueue()
    queue.register('flaky', async () => {
      throw new Error('nope')
    })
    await queue.enqueue('flaky', {}, { maxAttempts: 3 })

    await queue.drain()

    const [row] = await db.select().from(jobs)
    expect(row!.status).toBe('queued')
    expect(row!.lastError).toBe('nope')
    expect(row!.runAt.getTime()).toBeGreaterThan(Date.now())
  })

  /**
   * Drizzle wraps a driver error in a DrizzleQueryError whose own message is only the
   * SQL and its parameters — the constraint violation, the deadlock, the dropped
   * connection all live on `cause`. Recording just `.message` cost us the one detail
   * worth keeping: twenty failed face jobs in production said nothing but "Failed
   * query: update people set face_count = ...", and by the time anyone looked, every
   * other log that could have named the real error had rolled over.
   */
  test('records the cause rather than the wrapper it arrived in', async () => {
    const queue = makeQueue()
    queue.register('wrapped', async () => {
      throw new Error('Failed query: update "people" set face_count = $1', {
        cause: new Error('deadlock detected'),
      })
    })
    await queue.enqueue('wrapped', {}, { maxAttempts: 1 })

    await queue.drain()

    const [row] = await db.select().from(jobs)
    expect(row!.lastError).toContain('deadlock detected')
    expect(row!.lastError).toContain('Failed query')
  })

  test('gives up after the attempt limit', async () => {
    const queue = makeQueue()
    let calls = 0
    queue.register('doomed', async () => {
      calls++
      throw new Error('still nope')
    })
    await queue.enqueue('doomed', {}, { maxAttempts: 2 })

    // Drain twice, clearing the backoff in between so the retry is eligible.
    await queue.drain()
    await db.update(jobs).set({ runAt: new Date(Date.now() - 1000) })
    await queue.drain()

    const [row] = await db.select().from(jobs)
    expect(calls).toBe(2)
    expect(row!.status).toBe('failed')
  })

  test('a job with no registered handler fails rather than spinning', async () => {
    const queue = makeQueue()
    await queue.enqueue('nobody-handles-this', {}, { maxAttempts: 1 })

    await queue.drain()

    const [row] = await db.select().from(jobs)
    expect(row!.status).toBe('failed')
    expect(row!.lastError).toContain('No handler registered')
  })

  /**
   * A worker that dies mid-job leaves its row `running` forever: `claim` only ever looks
   * at `queued`, so nothing reclaims it and the work is simply lost. Thirteen jobs sat
   * that way in production for eleven days, and four of them were `asset.ingest` — which
   * held back 364 photos that had already been uploaded.
   */
  test('reclaims a job a dead worker left running', async () => {
    const queue = makeQueue()
    const [job] = await db
      .insert(jobs)
      .values({
        name: 'stranded',
        payload: {},
        status: 'running',
        attempts: 1,
        maxAttempts: 5,
        startedAt: new Date(Date.now() - 60 * 60_000),
      })
      .returning()

    expect(await queue.reclaimStale()).toBe(1)

    const [row] = await db.select().from(jobs).where(eq(jobs.id, job!.id))
    expect(row!.status).toBe('queued')
    expect(row!.startedAt).toBeNull()
  })

  test('leaves a job that is still genuinely running alone', async () => {
    const queue = makeQueue()
    await db.insert(jobs).values({
      name: 'busy',
      payload: {},
      status: 'running',
      attempts: 1,
      startedAt: new Date(),
    })

    expect(await queue.reclaimStale()).toBe(0)

    const [row] = await db.select().from(jobs)
    expect(row!.status).toBe('running')
  })

  /**
   * The crash that strands a job may well be the job's own doing — a photo that kills the
   * process is reclaimed, retried, and kills it again. `claim` does not check the attempt
   * limit, so reclaiming such a job forever would be a crash loop rather than a recovery.
   */
  test('fails a reclaimed job that is out of attempts rather than looping on it', async () => {
    const queue = makeQueue()
    await db.insert(jobs).values({
      name: 'poison',
      payload: {},
      status: 'running',
      attempts: 5,
      maxAttempts: 5,
      startedAt: new Date(Date.now() - 60 * 60_000),
    })

    expect(await queue.reclaimStale()).toBe(1)

    const [row] = await db.select().from(jobs)
    expect(row!.status).toBe('failed')
    expect(row!.finishedAt).not.toBeNull()
  })

  test('one failing job does not stop the next one', async () => {
    const queue = makeQueue()
    const done: string[] = []
    queue.register('bad', async () => {
      throw new Error('bad')
    })
    queue.register('good', async () => {
      done.push('good')
    })
    await queue.enqueue('bad', {}, { runAt: new Date(Date.now() - 5000) })
    await queue.enqueue('good', {}, { runAt: new Date(Date.now() - 1000) })

    await queue.drain()

    expect(done).toEqual(['good'])
  })
})

describe('concurrent claiming', () => {
  test('never hands the same job to two workers', async () => {
    const queue = makeQueue(8)
    const runs = new Map<string, number>()
    queue.register('count', async (p) => {
      const id = p.id as string
      runs.set(id, (runs.get(id) ?? 0) + 1)
      await Bun.sleep(5)
    })
    for (let i = 0; i < 24; i++) await queue.enqueue('count', { id: `job-${i}` })

    // Eight independent drains race for the same rows, which is what the server does.
    await Promise.all(Array.from({ length: 8 }, () => queue.drain()))

    expect(runs.size).toBe(24)
    expect([...runs.values()].every((n) => n === 1)).toBe(true)
    const remaining = await db.select().from(jobs).where(eq(jobs.status, 'queued'))
    expect(remaining).toBeEmpty()
  })
})

describe('housekeeping', () => {
  test('prunes finished jobs older than the retention window', async () => {
    const queue = makeQueue()
    queue.register('old', async () => {})
    await queue.enqueue('old', {})
    await queue.drain()
    await db.update(jobs).set({ finishedAt: new Date(Date.now() - 30 * 24 * 3600 * 1000) })

    await queue.pruneCompleted(7)

    expect(await db.select().from(jobs)).toBeEmpty()
  })

  test('keeps recent finished jobs', async () => {
    const queue = makeQueue()
    queue.register('recent', async () => {})
    await queue.enqueue('recent', {})
    await queue.drain()

    await queue.pruneCompleted(7)

    expect(await db.select().from(jobs)).toHaveLength(1)
  })
})

/**
 * A worker that cannot reach the database has to complain, not disappear.
 *
 * In #71 every pooled connection was stranded, so `claim()` waited for one for ever. It
 * never threw, so the `catch` below it never ran, and four workers went quiet while 570
 * uploads sat untouched for 25 hours. The database backstop turns that wait into a
 * rejection; this is the half that has to survive the rejection and keep asking.
 */
describe('a worker whose database is unreachable', () => {
  // Shaped the way drizzle actually reports it: the wrapper's own message is the SQL and
  // nothing else, and the reason anyone could act on is on `cause`.
  const unreachable = () =>
    Promise.reject(
      new Error('Failed query: update "jobs" set status = $1', {
        cause: new Error('Database query timed out after 45000ms without reaching Postgres'),
      }),
    )
  const brokenDb = { execute: unreachable, update: unreachable } as unknown as Database

  test('keeps running, and says why, rather than falling silent', async () => {
    const said: string[] = []
    const wasError = console.error
    console.error = (...parts: unknown[]) => said.push(parts.join(' '))

    const queue = new JobQueue(brokenDb, { concurrency: 2, idlePollMs: 5 })
    queue.start()
    try {
      await Bun.sleep(120)
    } finally {
      console.error = wasError
      await queue.stop()
    }

    // Still asking after many failures, and each one names the reason rather than the SQL.
    expect(said.length).toBeGreaterThan(2)
    expect(said.join('\n')).toMatch(/timed out/i)
  })

  test('recovers on its own once the database answers again', async () => {
    let reachable = false
    const flaky = new Proxy(db as object, {
      get(target, prop, receiver) {
        if (!reachable && prop === 'execute') return unreachable
        return Reflect.get(target, prop, receiver)
      },
    }) as Database

    const ran: string[] = []
    const queue = new JobQueue(flaky, { concurrency: 1, idlePollMs: 5 })
    queue.register('later', async () => {
      ran.push('later')
    })
    await queue.enqueue('later', {})

    const wasError = console.error
    console.error = () => {}
    queue.start()
    await Bun.sleep(60)
    expect(ran).toBeEmpty()

    reachable = true
    await Bun.sleep(300)
    console.error = wasError
    await queue.stop()

    expect(ran).toEqual(['later'])
  })
})
