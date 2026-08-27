import type { AssetFilter, TimelineTile } from '@imogen/shared'
import { useCallback, useMemo, useRef, useState } from 'react'
import { periodOf, segmentsInRange } from '../lib/timelineLayout.ts'
import { neighbouringPeriod, tilesInTimelineOrder } from './timelineWindow.ts'
import { useGridLayout } from './useGridLayout.ts'
import { type TimelineOptions, type TimelineWindow, useTimeline } from './useTimeline.ts'

/**
 * Everything a route has to wire up to put a windowed timeline on the page, done once.
 *
 * There are five of these routes now — the library, an album, a person, the vault, a
 * shared link — and the wiring between them is identical and unforgiving. The grid element
 * has to be held as state rather than a ref or the rail never renders; the visible range
 * has to be turned into months and handed back or nothing is ever fetched; the months on
 * screen have to be remembered separately or the viewer asking for one more unpins the
 * rest. Every one of those is silent when it is wrong: the page renders, and stays empty.
 *
 * So the routes get this, and keep only their own chrome. What differs between them is
 * the filter, the source, and what sits above the grid.
 */
export type TimelineGrid = TimelineWindow & {
  options: ReturnType<typeof useGridLayout>['options']
  /** Attach to `PhotoGrid`; measures the layout and hands the element to the rail. */
  attachGrid: (element: HTMLDivElement | null) => void
  /** The grid element itself, for the rail and the overview to scroll. */
  grid: HTMLDivElement | null
  /** The loaded tiles in true timeline order rather than in arrival order. */
  ordered: TimelineTile[]
  ids: string[]
  onVisibleRangeChange: (top: number, bottom: number) => void
  showingOverview: boolean
  setShowingOverview: (open: boolean) => void
  /** Asks for one month beyond what is on screen without unpinning what is. */
  requestNeighbour: (date: string, direction: number) => string | null
}

export function useTimelineGrid(
  query: Partial<AssetFilter>,
  timelineOptions: TimelineOptions = {},
): TimelineGrid {
  const { attachContainer, options } = useGridLayout()
  const window = useTimeline(query, options, timelineOptions)
  const { table, tiles, requestPeriods } = window

  /**
   * The grid element, held here as well as inside `PhotoGrid`, because the rail and the
   * overview both write the scroll position the grid reads and need its coordinate space
   * to do it. State rather than a ref: the rail has to render again once the element
   * exists, and a ref would not tell it that it does.
   */
  const [grid, setGrid] = useState<HTMLDivElement | null>(null)
  const attachGrid = useCallback(
    (element: HTMLDivElement | null) => {
      setGrid(element)
      attachContainer(element)
    },
    [attachContainer],
  )

  const [showingOverview, setShowingOverview] = useState(false)

  const ordered = useMemo(() => tilesInTimelineOrder(table, tiles), [table, tiles])
  const ids = useMemo(() => ordered.map((tile) => tile.id), [ordered])

  /** What the reader can see, kept so the viewer can ask for a month without unpinning it. */
  const onScreenPeriods = useRef<string[]>([])

  const onVisibleRangeChange = useCallback(
    (top: number, bottom: number) => {
      const periods = new Set<string>()
      for (const segment of segmentsInRange(table, top, bottom)) periods.add(periodOf(segment.date))
      onScreenPeriods.current = [...periods]
      requestPeriods(onScreenPeriods.current)
    },
    [table, requestPeriods],
  )

  const requestNeighbour = useCallback(
    (date: string, direction: number) => {
      const period = neighbouringPeriod(table, date, direction)
      if (!period) return null
      requestPeriods([...new Set([...onScreenPeriods.current, period])])
      return period
    },
    [table, requestPeriods],
  )

  return {
    ...window,
    options,
    attachGrid,
    grid,
    ordered,
    ids,
    onVisibleRangeChange,
    showingOverview,
    setShowingOverview,
    requestNeighbour,
  }
}
