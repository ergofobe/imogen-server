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
 *
 * A floor rather than a ceiling: `evictPeriods` lets the pinned set through whatever this
 * says, and the pinned set is what `periodsToFetch` asked for. A viewport spanning more
 * months than this holds all of them, because a month that can be requested and cannot be
 * kept is a month that is fetched, evicted and fetched again for as long as it is on screen.
 */
export const MAX_LOADED_PERIODS = 8

/**
 * The months worth having in hand for a given view: the ones on screen, and one either
 * side so scrolling in either direction meets tiles that are already there.
 *
 * Neighbours come from the spine's own list rather than from arithmetic on the month, so a
 * library with a gap in it reaches across the gap to a month that actually exists instead
 * of asking for an empty one.
 *
 * This is also what gets pinned against eviction. The two must be the same list: a month
 * this asks for that eviction is free to take is refetched the moment it lands.
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
 * Which loaded months survive, given what may be asked for.
 *
 * `pinned` is `periodsToFetch`'s answer, not the bare visible list, and it wins over the cap
 * without exception. A drag across a year can put more months in the viewport than the
 * budget allows, and evicting one of those to honour a number would blank the very rows the
 * reader is looking at — or worse, would evict a month the fetcher is about to ask for
 * again, which is a round trip per lap rather than a blank. The cap exists to stop a long
 * scroll accumulating a library's worth of tiles, not to be defended against the reader.
 */
export function evictPeriods(usedInOrder: string[], pinned: string[]): string[] {
  const keep = new Set(pinned)
  // Backwards from the most recently used, so what survives is what the reader is nearest.
  for (let i = usedInOrder.length - 1; i >= 0 && keep.size < MAX_LOADED_PERIODS; i--) {
    keep.add(usedInOrder[i]!)
  }
  return usedInOrder.filter((period) => keep.has(period))
}

/**
 * At most two months are polled while an import runs.
 *
 * The cap is the point of the narrowing rather than a detail of it. A backfill lands
 * photographs across fifteen years at once, so "every month holding something unfinished"
 * is, during exactly the import this matters for, every month loaded — and asking for all
 * of them every two seconds is the whole-library refetch this replaced, wearing a filter.
 */
export const MAX_SETTLING_PERIODS = 2

/**
 * The months worth asking about again while an upload finishes.
 *
 * An upload lands as `pending` and a background worker thumbnails it, so the timeline has to
 * find out when that finishes and nothing tells it. Polling is the only way, and the only
 * thing worth polling is a month with something unfinished in it: a month of settled
 * photographs cannot change without a mutation, and a mutation invalidates the spine anyway.
 *
 * `periods` is least-recently-used first, so this walks it backwards — when the cap has to
 * choose between months it chooses the ones nearest the reader, whose blank tiles are the
 * ones they are waiting to see fill in. An empty result means no traffic at all, which is
 * the state a library that is not importing anything should sit in.
 */
export function periodsSettling(loaded: {
  byDay: Map<string, TimelineTile[]>
  periods: string[]
}): string[] {
  const unfinished = new Set<string>()
  for (const [day, tiles] of loaded.byDay) {
    if (tiles.some((tile) => tile.status === 'pending' || tile.status === 'processing')) {
      unfinished.add(periodOf(day))
    }
  }

  const chosen: string[] = []
  for (let i = loaded.periods.length - 1; i >= 0 && chosen.length < MAX_SETTLING_PERIODS; i--) {
    const period = loaded.periods[i]!
    if (unfinished.has(period)) chosen.push(period)
  }
  // Back into the order the months are held in, so the same set always produces the same
  // list and the poll's own restart check does not see a change where there was none.
  return chosen.reverse()
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
 * The loaded months whose day counts the spine no longer agrees with, and which therefore
 * have to be fetched again.
 *
 * The tile map is not a query and nothing invalidates it, so without this an upload landing
 * mid-scroll would size its day for one more photograph than the day draws — the spine knows
 * about it, the tiles do not — and a photograph given a corrected date would leave both the
 * day it left and the day it joined wrong. A day the spine now lists that a loaded month
 * holds no tiles for counts as a disagreement too, which is what a new day's first upload
 * looks like.
 *
 * It compares counts and nothing else, so what it guarantees is narrow: a mutation that moves
 * a photograph between days, adds one, or removes one is caught, and a mutation that changes
 * a photograph while leaving every count alone is not. Favouriting, describing, and
 * correcting a capture time within the same UTC day all fall in the second group, and their
 * tiles stay as they were until that month is fetched again for some other reason. Comparing
 * the tiles themselves would mean holding a second copy of the month to compare against,
 * which is the thing this whole hook exists to avoid.
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
 * A period fetch tied to the question it was asked under, whose answer is delivered only
 * while that is still the question being asked.
 *
 * A counter bumped on every filter change cannot do this job, because the loader may re-run a
 * fetch long after it was created: a reload queued behind a flight runs when that flight
 * lands. A counter read at that moment answers "has anything changed since I started", and the
 * re-run started late — after the filter change it was supposed to notice — so it sees a
 * counter that has already settled and lets tiles from the previous filter into the map.
 * Switch to Favourites while a reload is queued and non-favourites arrive; nothing corrects it,
 * because the spine does not change again.
 *
 * `askedUnder` is the question THIS fetch was made under, carried with the fetch rather than
 * read from anywhere, so the comparison means the same thing no matter when or how often it
 * runs.
 *
 * It is a string, and deliberately not a generic: the question has to be the filter's CONTENT,
 * not the object holding it. A caller that mutates its filter in place rather than replacing
 * it changes what the fetch means while leaving every object identity alone, and an identity
 * comparison would see nothing at all and deliver the old filter's tiles into the new filter's
 * map — the same bug this guard exists to prevent, arriving through a different door. Typing
 * it as a string is what stops a caller passing the object by accident: doing so does not
 * compile.
 *
 * What it guarantees, exactly: an answer reaches `deliver` only while the filter content that
 * produced it is still the content being asked about. Two filters that serialise the same are
 * the same question, so a fetch that outlives a detour to another filter and back is still
 * delivered — its tiles are the ones the current filter wants. Two that serialise differently
 * are different questions even when they would select the same photographs, which
 * over-discards and never under-discards. It says nothing about the answer being fresh: a
 * mutation during the flight is the loader's problem, not this one's.
 */
export function createGuardedPeriodFetch(options: {
  askedUnder: string
  currentQuestion: () => string
  fetchPeriod: (period: string) => Promise<TimelineTile[]>
  deliver: (period: string, tiles: TimelineTile[]) => void
}): (period: string) => Promise<void> {
  const { askedUnder, currentQuestion, fetchPeriod, deliver } = options
  return async (period) => {
    // Checked before the request as well as after it: a re-run that begins after the question
    // has moved on should not spend a round trip on an answer nobody can use.
    if (askedUnder !== currentQuestion()) return
    const tiles = await fetchPeriod(period)
    if (askedUnder !== currentQuestion()) return
    deliver(period, tiles)
  }
}

export type PeriodLoader = {
  /** Fetches a period unless one is already being fetched for it. */
  load: (period: string) => Promise<void>
  /** Fetches it again even if one is in flight, because that one is answering a stale question. */
  reload: (period: string) => Promise<void>
}

/**
 * Runs at most one fetch per period at a time, and tells `load` and `reload` apart.
 *
 * `load` is the scroll path: a period that is already on its way needs nothing, and dropping
 * the duplicate is the whole point — a reader scrolling through unfetched months asks for the
 * same one on every band.
 *
 * `reload` is the mutation path, and dropping it there is a bug rather than an economy. A
 * fetch already in flight was sent before whatever made the period stale, so it is answering
 * a question from before the upload and will land carrying pre-mutation tiles. Discarding the
 * request would leave the map holding those tiles with nothing left to ask again: the spine
 * has already changed, and it does not change a second time. So a `reload` that arrives
 * mid-flight is remembered and run once more when the flight lands, however many arrive.
 */
export function createPeriodLoader(fetchPeriod: (period: string) => Promise<void>): PeriodLoader {
  const running = new Set<string>()
  const stale = new Set<string>()

  const run = async (period: string) => {
    running.add(period)
    try {
      let failed = false
      let failure: unknown
      do {
        // Cleared before the fetch, not after: anything arriving while it is in the air has
        // to count, and clearing afterwards would swallow exactly those.
        stale.delete(period)
        failed = false
        try {
          await fetchPeriod(period)
        } catch (error) {
          // A request queued behind a failed flight is still worth making. The mark means the
          // map is known to hold tiles from before a mutation, and a request that failed has
          // not made that any less true — letting the failure carry the mark out with it would
          // turn one dropped request into permanent staleness, with nothing left to ask again.
          // At most one further attempt follows, because the mark is consumed before it.
          failed = true
          failure = error
        }
      } while (stale.has(period))
      if (failed) throw failure
    } finally {
      running.delete(period)
      stale.delete(period)
    }
  }

  return {
    load: async (period) => {
      if (running.has(period)) return
      await run(period)
    },
    reload: async (period) => {
      if (running.has(period)) {
        stale.add(period)
        return
      }
      await run(period)
    },
  }
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
