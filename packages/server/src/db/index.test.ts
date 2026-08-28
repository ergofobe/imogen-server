import { afterAll, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { createTestDatabase } from '../test/harness.ts'

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
