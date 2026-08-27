import type { AssetFilter, TimelineBucket, TimelineTile } from '@imogen/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { imogen } from '../lib/client.ts'
import {
  buildSegments,
  groupTilesByDay,
  type LayoutOptions,
  periodOf,
  type SegmentTable,
} from '../lib/timelineLayout.ts'
import {
  collectPeriod,
  createGuardedPeriodFetch,
  createPeriodLoader,
  evictPeriods,
  mergeDays,
  periodsOutOfDate,
  periodsToFetch,
} from './timelineWindow.ts'

export {
  anchoredScrollTop,
  collectPeriod,
  createGuardedPeriodFetch,
  createPeriodLoader,
  evictPeriods,
  MAX_LOADED_PERIODS,
  mergeDays,
  periodsOutOfDate,
  periodsToFetch,
} from './timelineWindow.ts'

/**
 * The timeline as a window rather than as a list.
 *
 * The spine — one row per day, counts only — is fetched once and sizes the whole scroller,
 * so the page is its true height from the first paint and the reader can be anywhere in
 * twenty years without waiting. Tiles are fetched a month at a time, for the months on
 * screen and their immediate neighbours, and are let go once they are far enough behind.
 * What stays behind is each day's measured height, which is what lets an evicted region
 * keep its place in the scroll.
 */

export type TimelineWindow = {
  table: SegmentTable
  /** By UTC day, for the days currently loaded. A day that is absent is drawn as blocks. */
  tiles: Map<string, TimelineTile[]>
  isPending: boolean
  /** Exact, from the spine: every day the filter matches is counted, not just fetched ones. */
  totalCount: number
  requestPeriods: (periods: string[]) => void
  suspendFetching: (suspended: boolean) => void
  /** Refetches the spine and every loaded period, after a mutation changes the library. */
  reload: () => void
}

type LoadedTiles = {
  byDay: Map<string, TimelineTile[]>
  /** Least recently used first, which is the order eviction walks. */
  periods: string[]
}

const NOTHING_LOADED: LoadedTiles = { byDay: new Map(), periods: [] }
const NO_BUCKETS: TimelineBucket[] = []

export function useTimeline(filter: Partial<AssetFilter>, options: LayoutOptions): TimelineWindow {
  const queryClient = useQueryClient()

  // Routes build their filter inline, so it is a new object on every render even when
  // nothing about it changed. Everything below keys on its content, not on its identity.
  const filterKey = JSON.stringify(filter)
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the filter's content
  const query = useMemo(() => filter, [filterKey])

  const spine = useQuery({
    queryKey: ['timeline', query],
    queryFn: () => imogen.assets.timeline(query),
    staleTime: 30_000,
  })

  const buckets = spine.data?.buckets ?? NO_BUCKETS
  const allPeriods = useMemo(
    () => [...new Set(buckets.map((bucket) => periodOf(bucket.date)))],
    [buckets],
  )
  const totalCount = useMemo(
    () => buckets.reduce((sum, bucket) => sum + bucket.count, 0),
    [buckets],
  )

  const [loaded, setLoaded] = useState<LoadedTiles>(NOTHING_LOADED)
  const [visiblePeriods, setVisiblePeriods] = useState<string[]>([])
  const [suspended, setSuspended] = useState(false)

  /**
   * Every height ever derived, kept for the life of the filter. Its keys carry the whole
   * layout, so a height learned at one width cannot be served at another and a resize has
   * nothing to clear. A different filter is another matter: the same day holds a different
   * number of photographs under it, and none of these heights describe it any more.
   */
  const measured = useRef(new Map<string, number>())

  const pinned = useRef<string[]>([])
  const loadedNow = useRef<LoadedTiles>(NOTHING_LOADED)
  /**
   * The filter on screen, as its content rather than as the object carrying it. A reply to any
   * other one is dropped rather than absorbed — and content, because a caller that mutated its
   * filter in place would leave every object identity untouched while changing what a fetch in
   * the air means.
   */
  const currentQuestion = useRef(filterKey)

  useLayoutEffect(() => {
    pinned.current = visiblePeriods
  }, [visiblePeriods])

  useLayoutEffect(() => {
    loadedNow.current = loaded
  }, [loaded])

  // On commit rather than during render: a render React abandons must not be able to declare
  // a filter current that never reached the screen, which would discard the real one's replies.
  useLayoutEffect(() => {
    currentQuestion.current = filterKey
  }, [filterKey])

  // biome-ignore lint/correctness/useExhaustiveDependencies: a filter change is the one thing that invalidates everything held
  useEffect(() => {
    measured.current = new Map()
    setLoaded(NOTHING_LOADED)
  }, [filterKey])

  // Keyed on `filterKey` as well as on `query`, because those two can part company: a filter
  // mutated in place changes its content while leaving the object it lives in alone, and this
  // has to be rebuilt to carry the new question when that happens.
  const fetchPeriod = useMemo(
    () =>
      createGuardedPeriodFetch({
        askedUnder: filterKey,
        currentQuestion: () => currentQuestion.current,
        // The endpoint pages at 5000 and a heavy month runs well past that; `collectPeriod`
        // follows the cursor to the end before any of it lands.
        fetchPeriod: (period) =>
          collectPeriod((cursor) =>
            imogen.assets.timelineBucket({ ...query, period, ...(cursor ? { cursor } : {}) }),
          ),
        deliver: (period, tiles) =>
          setLoaded((current) => absorb(current, period, tiles, pinned.current)),
      }),
    [filterKey, query],
  )

  // Rebuilt when the filter changes, which discards what the old one was tracking. Anything
  // still in the air from it — including a reload it had queued — is dropped on arrival,
  // because the fetch carries the filter it was made under and compares that, not a counter.
  const periods = useMemo(() => createPeriodLoader(fetchPeriod), [fetchPeriod])

  const wanted = useMemo(
    () => periodsToFetch(visiblePeriods, allPeriods),
    [visiblePeriods, allPeriods],
  )

  useEffect(() => {
    if (suspended) return
    for (const period of wanted) {
      if (loaded.periods.includes(period)) continue
      void periods.load(period)
    }
  }, [wanted, suspended, loaded.periods, periods])

  /*
   * The tile map is not a query, so nothing invalidates it. When a fresh spine disagrees with
   * what a loaded month holds — an upload landed, a date was corrected, a day was emptied —
   * that month is fetched again in place. So a mutation that changes a day's count only has
   * to invalidate `['timeline']`; one that changes a photograph without changing any count
   * is not seen here, and its tile stays as it was.
   *
   * `reload` rather than `load`, because a fetch may already be in flight for that month —
   * one sent before the mutation, which will land carrying the tiles this is trying to
   * replace. Dropping the request then would leave the map stale with nothing left to trigger
   * another attempt, since the spine has already changed and will not change again.
   *
   * The map is read through a ref rather than taken as a dependency: depending on it would
   * re-run this on its own result, and only a fresh spine can make a loaded month stale.
   */
  useEffect(() => {
    for (const period of periodsOutOfDate(buckets, loadedNow.current)) void periods.reload(period)
  }, [buckets, periods])

  const reload = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['timeline'] })
    for (const period of loadedNow.current.periods) void periods.reload(period)
  }, [queryClient, periods])

  /*
   * An upload lands as `pending` and a background worker thumbnails it, so the timeline has
   * to find out when that finishes. Polling runs only while something in hand is actually
   * in flight and stops the moment it settles — no upload, no traffic.
   */
  const settling = useMemo(
    () =>
      [...loaded.byDay.values()].some((day) =>
        day.some((tile) => tile.status === 'pending' || tile.status === 'processing'),
      ),
    [loaded.byDay],
  )

  useEffect(() => {
    if (!settling || suspended) return
    const timer = setInterval(reload, 2000)
    return () => clearInterval(timer)
  }, [settling, suspended, reload])

  const table = useMemo(
    () => buildSegments(buckets, loaded.byDay, options, measured.current),
    [buckets, loaded.byDay, options],
  )

  const requestPeriods = useCallback((periods: string[]) => {
    setVisiblePeriods((current) => (sameList(current, periods) ? current : periods))
  }, [])

  const suspendFetching = useCallback((next: boolean) => setSuspended(next), [])

  return {
    table,
    tiles: loaded.byDay,
    isPending: spine.isPending,
    totalCount,
    requestPeriods,
    suspendFetching,
    reload,
  }
}

/**
 * The same table, for a view that already holds every photograph it will ever show — an
 * album, a person, the vault, a shared link. Those are bounded by construction, so there is
 * nothing to window and nothing to fetch: they want the geometry, not the machinery.
 */
export function useAssetTable(
  assets: TimelineTile[],
  options: LayoutOptions,
): { table: SegmentTable; tiles: Map<string, TimelineTile[]> } {
  const measured = useRef(new Map<string, number>())

  const tiles = useMemo(() => groupTilesByDay(assets), [assets])
  const table = useMemo(() => {
    const buckets = [...tiles].map(([date, dayTiles]) => ({
      date,
      count: dayTiles.length,
      coverAssetId: null,
    }))
    return buildSegments(buckets, tiles, options, measured.current)
  }, [tiles, options])

  return { table, tiles }
}

function absorb(
  current: LoadedTiles,
  period: string,
  tiles: TimelineTile[],
  pinned: string[],
): LoadedTiles {
  const periods = [...current.periods.filter((each) => each !== period), period]
  const kept = evictPeriods(periods, pinned)
  const byDay = mergeDays(current.byDay, period, tiles)
  if (kept.length === periods.length) return { byDay, periods: kept }

  const surviving = new Set(kept)
  const trimmed = new Map<string, TimelineTile[]>()
  for (const [day, dayTiles] of byDay) {
    if (surviving.has(periodOf(day))) trimmed.set(day, dayTiles)
  }
  return { byDay: trimmed, periods: kept }
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}
