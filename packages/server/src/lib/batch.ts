/**
 * Splits a list into chunks of at most `size`. Used wherever a `WHERE … IN (…)` or a
 * multi-row INSERT would otherwise bind one query parameter per row: a selection
 * resolved from a filter can run to tens of thousands of ids, and Postgres refuses a
 * statement bound to more than 65,535 parameters.
 */
export function chunk<T>(items: T[], size: number): T[][] {
  // A size below 1 would loop forever slicing an empty range. Only reachable today
  // through a test-only constructor override, but a shared helper should not have a
  // silent infinite loop as a failure mode.
  const step = Math.max(1, size)
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += step) batches.push(items.slice(i, i + step))
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

/**
 * How many photographs travel with an album or a person. Enough to draw a cover and a
 * glance; not a substitute for the timeline, which is where the grid gets its contents
 * now. An album of thirty thousand used to arrive here in full, as full Assets.
 *
 * Lives here rather than in `media/albums.ts`, where the brief for this cap first put
 * it: `faces/faces.ts` needs the same number, and a faces module reaching into the
 * albums module for a constant would be a dependency with nothing to do with faces.
 * `lib/` already exists for exactly this — a value more than one domain needs to agree
 * on, same as `BULK_BATCH_SIZE` above.
 */
export const COVER_SAMPLE = 60
