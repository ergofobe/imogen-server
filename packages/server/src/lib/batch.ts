/**
 * Splits a list into chunks of at most `size`. Used wherever a `WHERE … IN (…)` or a
 * multi-row INSERT would otherwise bind one query parameter per row: a selection
 * resolved from a filter can run to tens of thousands of ids, and Postgres refuses a
 * statement bound to more than 65,535 parameters.
 */
export function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size))
  return batches
}

/**
 * A conservative default for any bulk id-list operation. The tightest consumer is an
 * album-membership insert, which binds three parameters per row (album id, asset id,
 * position) — its real ceiling is 65,535 / 3 ≈ 21,845. 5,000 leaves wide headroom under
 * that for every shape a batch feeds (a plain `IN` list, an insert, a delete), so one
 * constant covers every call site without per-query tuning.
 */
export const BULK_BATCH_SIZE = 5000
