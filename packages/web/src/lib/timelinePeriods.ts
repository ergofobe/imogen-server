/**
 * The overview's rollup: day buckets gathered into the years and months a person actually
 * thinks in.
 *
 * Separate from `timelineLayout` because it is not geometry — it answers "what is even
 * back there" rather than "how tall is it" — and separate from the component so it can be
 * tested without a DOM, like everything else in this repo.
 */

/** A period as an overview card draws it. */
export type PeriodCard = {
  /** '2012' or '2012-06'. Also the key the next level down filters on. */
  key: string
  count: number
  /**
   * The newest ready photograph in the period, or null. Null is ordinary, not exceptional:
   * a period still being imported has no ready asset to stand for it, and it shows its
   * count on a bare ground rather than dropping out of the overview.
   */
  coverAssetId: string | null
  /**
   * The newest day in the period, which is where the timeline shows it — days run newest
   * first, so a period begins at its newest day.
   */
  topDate: string
}

/** Only the fields a rollup reads, so a `DaySegment` stands in for a bucket unchanged. */
type BucketLike = { date: string; count: number; coverAssetId?: string | null }

/**
 * Gathers day buckets into periods, in the order they arrive.
 *
 * The caller's ordering is the result's ordering, which for every caller here means newest
 * first. That is what makes the first cover found the newest one and the first day seen
 * the period's top, with no sorting and no date arithmetic.
 */
export function rollUpPeriods(
  buckets: readonly BucketLike[],
  level: 'year' | 'month',
): PeriodCard[] {
  const width = level === 'year' ? 4 : 7
  const cards = new Map<string, PeriodCard>()

  for (const bucket of buckets) {
    const key = bucket.date.slice(0, width)
    const card = cards.get(key)
    if (!card) {
      cards.set(key, {
        key,
        count: bucket.count,
        coverAssetId: bucket.coverAssetId ?? null,
        topDate: bucket.date,
      })
      continue
    }
    card.count += bucket.count
    // The first cover wins, so a period is represented by its newest ready photograph —
    // and a run of still-processing days at the top of it is stepped over rather than
    // leaving the whole period blank.
    if (card.coverAssetId === null) card.coverAssetId = bucket.coverAssetId ?? null
  }

  return [...cards.values()]
}
