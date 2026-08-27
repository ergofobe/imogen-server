import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import * as schema from './schema.ts'

export type Database = ReturnType<typeof createDatabase>

/**
 * A stranded connection should self-heal, not sit `idle in transaction` forever. A
 * client that vanishes mid-request (a dropped upload, a killed tab) can otherwise leave
 * a transaction open indefinitely; these bound how long Postgres will wait before
 * reclaiming it, so one abandoned request degrades a few seconds of throughput instead
 * of wedging the whole pool. See #9.
 */
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000
const LOCK_TIMEOUT_MS = 10_000
const STATEMENT_TIMEOUT_MS = 30_000

export function createDatabase(url: string) {
  const client = new SQL(url, {
    connection: {
      idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
      lock_timeout: LOCK_TIMEOUT_MS,
      statement_timeout: STATEMENT_TIMEOUT_MS,
    },
  })
  return drizzle({ client, schema, casing: 'snake_case' })
}

export * from './schema.ts'
export { schema }
