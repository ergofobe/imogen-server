import type { TimelineBucket, TimelineTile } from '@imogen/shared'
import { groupTilesByDay, periodOf, type SegmentTable, scrollDelta } from '../lib/timelineLayout.ts'

/**
 * The policy behind `useTimeline`: which months to hold, which to let go, how pages of one
 * month add up, and where the scroller has to end up when the geometry underneath it
 * changes. Separated from the hook the way `pull.ts` is separated from `usePullToRefresh`,
 * so the decisions can be tested for what they decide rather than through a renderer.
 */

/**
 * Eight months of tiles. A month of heavy shooting is a few thousand tiles at roughly 200
 * bytes each, so eight is a handful of megabytes — enough that a reader can wander up and
 * down a season without refetching, and far short of the whole library.
 */
export const MAX_LOADED_PERIODS = 8

/**
 * The months worth having in hand for a given view: the ones on screen, and one either
 * side so scrolling in either direction meets tiles that are already there.
 *
 * Neighbours come from the spine's own list rather than from arithmetic on the month, so a
 * library with a gap in it reaches across the gap to a month that actually exists instead
 * of asking for an empty one.
 */
export function periodsToFetch(visiblePeriods: string[], allPeriods: string[]): string[] {
  const wanted = new Set<string>()
  for (const period of visiblePeriods) {
    const index = allPeriods.indexOf(period)
    if (index < 0) continue
    for (const neighbour of [index - 1, index, index + 1]) {
      const candidate = allPeriods[neighbour]
      if (candidate) wanted.add(candidate)
    }
  }
  return allPeriods.filter((period) => wanted.has(period))
}

/**
 * Which loaded months survive, given what is on screen.
 *
 * `pinned` wins over the cap without exception: a drag across a year can put more months in
 * the viewport than the budget allows, and evicting one of those to honour a number would
 * blank the very rows the reader is looking at. The cap exists to stop a long scroll
 * accumulating a library's worth of tiles, not to be defended against the reader.
 */
export function evictPeriods(usedInOrder: string[], pinned: string[]): string[] {
  const keep = new Set(pinned)
  // Backwards from the most recently used, so what survives is what the reader is nearest.
  for (let i = usedInOrder.length - 1; i >= 0 && keep.size < MAX_LOADED_PERIODS; i--) {
    keep.add(usedInOrder[i]!)
  }
  return usedInOrder.filter((period) => keep.has(period))
}

/** One page of the bucket endpoint: the shape `imogen.assets.timelineBucket` answers with. */
export type TilePage = { items: TimelineTile[]; nextCursor: string | null }

/**
 * One period, whole, however many pages the server chooses to answer in.
 *
 * The cursor is followed to null and the pages are concatenated before anything is returned,
 * because a period is only useful complete: a day straddling a page boundary holds fewer
 * tiles than its bucket count until the last page is in, and the geometry module rightly
 * refuses to measure a day that looks half empty. Landing a page at a time would leave such
 * a day on an estimate for as long as it stayed loaded.
 *
 * Takes the fetch as an argument so this can be exercised without the SDK client, which
 * reads `window` the moment it is imported.
 */
export async function collectPeriod(
  fetchPage: (cursor: string | undefined) => Promise<TilePage>,
): Promise<TimelineTile[]> {
  const collected: TimelineTile[] = []
  let cursor: string | undefined
  do {
    const page = await fetchPage(cursor)
    for (const tile of page.items) collected.push(tile)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return collected
}

/**
 * The loaded months the spine no longer agrees with, and which therefore have to be fetched
 * again.
 *
 * The tile map is not a query and nothing invalidates it, so without this an upload landing
 * mid-scroll would size its day for one more photograph than the day draws — the spine knows
 * about it, the tiles do not — and a photograph given a corrected date would leave both the
 * day it left and the day it joined wrong. Comparing counts makes the spine the single thing
 * that has to be refreshed after a mutation: whatever it says has changed is refetched, and
 * the caller does not have to know which days a mutation touched.
 *
 * A day the spine now lists that a loaded month holds no tiles for counts as a disagreement
 * too: that is exactly what a new day's first upload looks like.
 */
export function periodsOutOfDate(
  buckets: TimelineBucket[],
  loaded: { byDay: Map<string, TimelineTile[]>; periods: string[] },
): string[] {
  if (loaded.periods.length === 0) return []
  const loadedPeriods = new Set(loaded.periods)
  const counted = new Map(buckets.map((bucket) => [bucket.date, bucket.count]))

  const stale = new Set<string>()
  for (const [day, tiles] of loaded.byDay) {
    if (counted.get(day) !== tiles.length) stale.add(periodOf(day))
  }
  for (const bucket of buckets) {
    const period = periodOf(bucket.date)
    if (loadedPeriods.has(period) && !loaded.byDay.has(bucket.date)) stale.add(period)
  }
  return loaded.periods.filter((period) => stale.has(period))
}

/**
 * Folds one period's tiles into the day map.
 *
 * The period's own days are replaced wholesale and every other day is left untouched, which
 * is the only shape that survives both of the things that happen here. A period arrives as
 * several pages of 5000 and must be assembled before it lands, because a day split across a
 * page boundary would otherwise never reach the count that lets the geometry measure it and
 * would sit on an estimate for as long as it stayed loaded. And a period refetched after a
 * mutation has to be able to shrink, so a day emptied into the trash leaves nothing behind.
 */
export function mergeDays(
  byDay: Map<string, TimelineTile[]>,
  period: string,
  tiles: TimelineTile[],
): Map<string, TimelineTile[]> {
  const merged = new Map<string, TimelineTile[]>()
  for (const [day, dayTiles] of byDay) {
    if (periodOf(day) !== period) merged.set(day, dayTiles)
  }
  for (const [day, dayTiles] of groupTilesByDay(tiles)) merged.set(day, dayTiles)
  return merged
}

/**
 * Every loaded photograph in the order the timeline shows them, days included that have not
 * been fetched — which is what makes stepping through the viewer a walk along the timeline
 * rather than a walk through whichever pages happened to arrive.
 */
export function tilesInTimelineOrder(
  table: SegmentTable,
  tiles: Map<string, TimelineTile[]>,
): TimelineTile[] {
  const ordered: TimelineTile[] = []
  for (const segment of table.segments) {
    const day = tiles.get(segment.date)
    if (!day) continue
    // A loop rather than a spread: a heavy day is tens of thousands of tiles, and that many
    // arguments at once overflows the stack.
    for (const tile of day) ordered.push(tile)
  }
  return ordered
}

/**
 * The month next door to a day, in the direction the reader is walking. The viewer uses it
 * to ask for the month it is about to need when it steps off the end of what is loaded.
 */
export function neighbouringPeriod(
  table: SegmentTable,
  date: string,
  direction: number,
): string | null {
  const index = table.segments.findIndex((segment) => segment.date === date)
  if (index < 0) return null
  const neighbour = table.segments[index + (direction > 0 ? 1 : -1)]
  return neighbour ? periodOf(neighbour.date) : null
}

/**
 * Where the scroller must end up so the photograph under the reader's eye stays where it
 * is when one segment table replaces another.
 *
 * `scrollDelta` cannot clamp its own answer — it has no idea how tall the viewport is — and
 * the browser clamps an out-of-range `scrollTop` assignment silently, so a compensation
 * that overshoots either end of the timeline would half-apply with nothing to signal it.
 * Clamping here against the scroller's real range makes that ceiling explicit and keeps the
 * arithmetic somewhere it can be checked.
 *
 * `gridOffset` is where the grid's own top sits inside the scroller's content: the tables
 * are in grid coordinates and the scroller is not, and the page title above the grid is the
 * difference between the two.
 */
export function anchoredScrollTop(
  previous: SegmentTable,
  next: SegmentTable,
  scroller: { scrollTop: number; scrollHeight: number; clientHeight: number },
  gridOffset: number,
): number {
  const delta = scrollDelta(previous, next, scroller.scrollTop - gridOffset)
  const furthest = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  return Math.min(furthest, Math.max(0, scroller.scrollTop + delta))
}
