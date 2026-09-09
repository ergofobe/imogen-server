import { afterAll, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { createTestDatabase } from '../test/harness.ts'
import { createDatabase } from './index.ts'

const harness = await createTestDatabase()

afterAll(() => harness.close())

/**
 * #9's server-side bound only works if these actually land on every pooled connection.
 * Bun's `connection` option is the one thing standing between "a stuck transaction
 * self-heals" and "it doesn't" — a renamed option or a typo'd GUC would be silent
 * otherwise, and nothing would fail until the next abandoned upload wedges the pool.
 */
describe('pool connections carry the timeout GUCs from #9', () => {
  test('idle_in_transaction_session_timeout, lock_timeout, and statement_timeout are set', async () => {
    const rows = await harness.db.execute<{ idle: string; lock: string; statement: string }>(sql`
      select current_setting('idle_in_transaction_session_timeout') as idle,
             current_setting('lock_timeout') as lock,
             current_setting('statement_timeout') as statement
    `)
    const row = (Array.isArray(rows) ? rows[0] : (rows as { rows: unknown[] }).rows[0]) as {
      idle: string
      lock: string
      statement: string
    }

    // Postgres's default is '0', meaning disabled — anything else means our value took.
    expect(row.idle).not.toBe('0')
    expect(row.lock).not.toBe('0')
    expect(row.statement).not.toBe('0')
  })
})

/**
 * drizzle reports a driver failure as a wrapper whose own message is only the SQL, and
 * puts the real one on `cause` — the same reason `JobQueue.describeError` exists.
 */
function reasons(error: unknown): string {
  const chain: string[] = []
  let current: unknown = error
  while (current instanceof Error) {
    chain.push(current.message)
    current = current.cause
  }
  return chain.join(': ')
}

/**
 * A pool with no connection left must fail, not wait.
 *
 * `statement_timeout` only bounds work Postgres has started; a caller still queuing for a
 * connection has not reached Postgres at all, and nothing bounded it. That is how #71
 * turned ten stranded connections into a silent 25-hour outage: the queue blocked inside
 * `claim()` for ever, so its `catch` never ran and it never said a word.
 *
 * Each test holds the pool's only connection and leaves the ceiling it is not measuring
 * far out of reach, so a failure names one backstop rather than either.
 */
describe('a pool that cannot hand out a connection', () => {
  test('rejects a query instead of hanging on it', async () => {
    const db = createDatabase(harness.url, {
      poolSize: 1,
      queryTimeoutMs: 300,
      transactionTimeoutMs: 30_000,
    })
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    // Occupy the only connection, the way a stranded one occupies it for ever.
    const holding = db.transaction(async () => {
      await held
    })
    await Bun.sleep(100)

    const started = Date.now()
    // drizzle hands back a lazy builder, so resolve it before asking how it settled.
    const failure = await Promise.resolve(db.execute(sql`select 1`)).then(
      () => null,
      (error: unknown) => error,
    )
    expect(reasons(failure)).toMatch(/timed out/i)
    // Proves it was the backstop that ended the wait, not the connection coming free.
    expect(Date.now() - started).toBeLessThan(3000)

    release()
    await holding
    await db.$client.end()
  })

  test('rejects a transaction instead of hanging on it', async () => {
    const db = createDatabase(harness.url, {
      poolSize: 1,
      queryTimeoutMs: 30_000,
      transactionTimeoutMs: 300,
    })
    // Hold the connection with a plain statement, so only the transaction ceiling is armed.
    const holding = Promise.resolve(db.execute(sql`select pg_sleep(2)`)).catch(() => {})
    await Bun.sleep(100)

    const failure = await db
      .transaction(async (tx) => tx.execute(sql`select 1`))
      .then(
        () => null,
        (error: unknown) => error,
      )
    expect(reasons(failure)).toMatch(/timed out/i)

    // The abandoned BEGIN is still queued on the connection; let it settle before the
    // client is torn down, or Bun surfaces the close as an error of its own.
    await holding
    await Bun.sleep(300)
    await db.$client.end()
  })

  test('leaves a healthy pool alone', async () => {
    const db = createDatabase(harness.url, { poolSize: 2, queryTimeoutMs: 5000 })

    expect(await db.execute(sql`select 1 as n`)).toBeDefined()
    await db.transaction(async (tx) => {
      await tx.execute(sql`select 1`)
    })
    // The wrapper must not break reading rows back, which drizzle does through `.values()`.
    const rows = await db.execute<{ n: number }>(sql`select 2 as n`)
    expect(JSON.stringify(rows)).toContain('2')

    await db.$client.end()
  })
})
