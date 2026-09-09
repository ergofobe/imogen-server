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

/**
 * Stated rather than inherited, because the number is load bearing: it is exactly how
 * many connections may be stranded before the server can do nothing at all. Ten is Bun's
 * own default, kept so this is a change of visibility and not of behaviour.
 */
const POOL_SIZE = 10

/**
 * Ceilings for work that never reaches Postgres.
 *
 * The three settings above are enforced by Postgres, so they only bound a query it has
 * already accepted. A caller still queuing for a pooled connection has not spoken to
 * Postgres at all, and nothing bounded it — which is how #71 became a silent 25-hour
 * outage rather than an error. Bun's pool can fail to return a connection after a
 * server-side error (oven-sh/bun#22395, #30947, #23215), and `lock_timeout` above is a
 * steady source of those under import load. Once all ten slots were gone every query
 * waited for ever: the job queue blocked inside `claim()`, so its `catch` never ran and
 * it never said a word.
 *
 * These are backstops, not deadlines. Both sit above what Postgres already allows, so a
 * query that merely runs long is cancelled by `statement_timeout` and reported properly;
 * reaching one of these means the pool itself is broken. The transaction ceiling is the
 * looser of the two because a transaction is several statements, each entitled to
 * `STATEMENT_TIMEOUT_MS` of its own.
 *
 * `idleTimeout` and `maxLifetime` would be the obvious way to recycle a stranded
 * connection instead. They are unusable: oven-sh/bun#30646 has them killing in-flight
 * queries rather than draining them, and is still open on Bun 1.4.
 */
const QUERY_TIMEOUT_MS = 45_000
const TRANSACTION_TIMEOUT_MS = 120_000

export type DatabaseOptions = {
  poolSize?: number
  queryTimeoutMs?: number
  transactionTimeoutMs?: number
}

function timedOut(what: string, ms: number): Error {
  return new Error(
    `Database ${what} timed out after ${ms}ms without reaching Postgres. ` +
      'The connection pool has no connection to give — see imogen-server#71.',
  )
}

function withTimeout<T>(work: PromiseLike<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timedOut(what, ms)), ms)
    // A backstop must never be the reason the process stays alive.
    timer.unref?.()
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Bun hands back a lazy query object rather than a promise: awaiting it runs it, and
 * `.values()` and `.raw()` reshape the rows and hand the same object back. drizzle uses
 * both, so the ceiling has to survive them rather than sitting on the first call alone.
 */
function guardQuery<T extends object>(query: T, ms: number): T {
  return new Proxy(query, {
    get(target, prop) {
      if (prop === 'then') {
        return (onFulfilled: never, onRejected: never) =>
          withTimeout(target as PromiseLike<unknown>, ms, 'query').then(onFulfilled, onRejected)
      }
      const value = Reflect.get(target, prop)
      if (typeof value !== 'function') return value
      const bound = value.bind(target)
      if (prop !== 'values' && prop !== 'raw') return bound
      return (...args: unknown[]) => {
        const next: unknown = bound(...args)
        const reshaped = next && typeof next === 'object' && 'then' in next
        return reshaped ? guardQuery(next as object, ms) : next
      }
    },
  })
}

function guardClient(client: SQL, queryMs: number, transactionMs: number): SQL {
  return new Proxy(client, {
    get(target, prop) {
      // `target` as the receiver, not the proxy: Bun's client reads private fields, and
      // those throw when the receiver is anything but the instance itself.
      const value = Reflect.get(target, prop)
      if (typeof value !== 'function') return value
      const bound = value.bind(target)
      if (prop === 'unsafe') {
        return (...args: unknown[]) => guardQuery(bound(...args) as object, queryMs)
      }
      // Statements inside a transaction run on a connection it already holds, so the
      // whole transaction carries one ceiling rather than each statement carrying its own.
      //
      // A ceiling can only report; it cannot cancel. If this ever fires on a transaction
      // that was genuinely running rather than one that never got a connection, the
      // caller is told it failed while the transaction goes on to commit. That is the
      // price of covering `begin` at all, and it is worth paying: leaving it uncovered
      // puts ingest, faces and vault — every write path — back to hanging for ever, which
      // is the whole of #71. The window is narrow by construction, since reaching this
      // needs a transaction slower than four consecutive `statement_timeout`s.
      if (prop === 'begin') {
        return (...args: unknown[]) =>
          withTimeout(bound(...args) as PromiseLike<unknown>, transactionMs, 'transaction')
      }
      return bound
    },
  }) as SQL
}

export function createDatabase(url: string, options: DatabaseOptions = {}) {
  const client = new SQL(url, {
    max: options.poolSize ?? POOL_SIZE,
    connection: {
      idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
      lock_timeout: LOCK_TIMEOUT_MS,
      statement_timeout: STATEMENT_TIMEOUT_MS,
    },
  })
  const guarded = guardClient(
    client,
    options.queryTimeoutMs ?? QUERY_TIMEOUT_MS,
    options.transactionTimeoutMs ?? TRANSACTION_TIMEOUT_MS,
  )
  return drizzle({ client: guarded, schema, casing: 'snake_case' })
}

export * from './schema.ts'
export { schema }
