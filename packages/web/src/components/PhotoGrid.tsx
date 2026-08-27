import type { TimelineTile } from '@imogen/shared'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { anchoredScrollTop } from '../hooks/timelineWindow.ts'
import { DAY_HEADER_CLASS, DAY_HEADING_CLASS } from '../hooks/useGridLayout.ts'
import { formatDayKeyHeading } from '../lib/format.ts'
import { aspectOf, justify } from '../lib/justify.ts'
import { gridOffsetWithin, scrollEventSourceFor, scrollingAncestorOf } from '../lib/scroller.ts'
import {
  estimateRowLayout,
  type LayoutOptions,
  type SegmentTable,
  segmentsInRange,
} from '../lib/timelineLayout.ts'
import { PhotoTile } from './PhotoTile.tsx'

type Props = {
  /** Where every day in the library sits, whether or not its photographs are in hand. */
  table: SegmentTable
  tiles: Map<string, TimelineTile[]>
  options: LayoutOptions
  /**
   * From `useGridLayout`, which measures the options above off this element. A callback ref
   * rather than a ref object, because the grid appears after its route's first commit and an
   * observer looking for it then would never find it.
   */
  attachContainer: (element: HTMLDivElement | null) => void
  selected: Set<string>
  onOpen: (tile: TimelineTile) => void
  onToggleSelect: (tile: TimelineTile, shiftKey: boolean) => void
  /** In grid coordinates, so the caller can turn it into the months worth fetching. */
  onVisibleRangeChange?: (top: number, bottom: number) => void
  /** A shared page has nothing to do with a selection, so it does not offer one. */
  selectable?: boolean
}

/**
 * How far beyond the viewport to draw, so a flick meets photographs rather than blanks.
 * Roughly a screen's worth on a laptop, which is about as far as a fast scroll travels
 * between two animation frames.
 */
const OVERSCAN = 1200

/**
 * The scroll position is rounded down to this before it reaches React. What gets drawn is a
 * band, not a pixel, and re-rendering the grid sixty times a second to move a band that has
 * not moved is most of what a virtualised list costs. Half the overscan leaves at least six
 * hundred pixels of drawn-but-unseen grid in either direction.
 */
const BAND = OVERSCAN / 2

/**
 * A window over the timeline: an element as tall as the whole library, with only the days
 * the viewport touches inside it.
 *
 * The grid used to render every photograph that had ever been fetched. A long scroll into a
 * large library ended with a hundred thousand nodes in the document and a justify pass over
 * all of them on every resize; this draws the handful of days a reader can actually see.
 */
export function PhotoGrid({
  table,
  tiles,
  options,
  attachContainer,
  selected,
  onOpen,
  onToggleSelect,
  onVisibleRangeChange,
  selectable = true,
}: Props) {
  const container = useRef<HTMLDivElement | null>(null)
  const [band, setBand] = useState({ top: 0, height: 0 })
  const previousTable = useRef<SegmentTable | null>(null)
  const readBand = useRef<(() => void) | undefined>(undefined)
  const reportRange = useRef(onVisibleRangeChange)
  reportRange.current = onVisibleRangeChange

  // One element, two readers: the hook measures it, and everything below reads scroll
  // positions off it. Keeping a local handle avoids asking the hook for its element back.
  const attach = useCallback(
    (element: HTMLDivElement | null) => {
      container.current = element
      attachContainer(element)
    },
    [attachContainer],
  )

  useEffect(() => {
    const element = container.current
    if (!element) return
    const scroller = scrollingAncestorOf(element)

    let frame = 0
    const read = () => {
      frame = 0
      const top = scroller.scrollTop - gridOffsetWithin(element, scroller)
      const height = scroller.clientHeight
      reportRange.current?.(top, top + height)
      // Only the band reaches React. The exact position goes to the caller, which uses it
      // to decide what to fetch and redraws nothing.
      const banded = Math.floor(top / BAND) * BAND
      setBand((current) =>
        current.top === banded && current.height === height ? current : { top: banded, height },
      )
    }
    readBand.current = read

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read)
    }
    read()

    const source = scrollEventSourceFor(scroller)
    source.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      readBand.current = undefined
      source.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [])

  /**
   * When a day's real measurements replace its estimate, every day below it moves. If that
   * day was above the viewport then the photograph under the reader moves with it, which is
   * the one thing this whole apparatus exists to prevent.
   *
   * A layout effect, emphatically not an effect: this has to run between React writing the
   * new heights into the document and the browser painting them. From a `useEffect` the
   * paint has already happened, and the correction is a visible jump rather than a
   * correction.
   */
  useLayoutEffect(() => {
    const previous = previousTable.current
    previousTable.current = table
    const element = container.current

    if (element && previous && previous.segments.length > 0) {
      const scroller = scrollingAncestorOf(element)
      const target = anchoredScrollTop(
        previous,
        table,
        scroller,
        gridOffsetWithin(element, scroller),
      )
      if (target !== scroller.scrollTop) scroller.scrollTop = target
    }

    // Every table is a different shape, and the first one the grid ever sees arrives after
    // the container has been measured — long after the only scroll event there has been.
    // Reading again here is what draws the right days and tells the caller which months it
    // needs, without waiting for the reader to touch the page.
    readBand.current?.()
  }, [table])

  const visible = useMemo(
    () => segmentsInRange(table, band.top - OVERSCAN, band.top + band.height + OVERSCAN),
    [table, band],
  )

  const selecting = selected.size > 0

  return (
    <div
      ref={attach}
      className="w-full"
      style={{ position: 'relative', height: table.totalHeight }}
    >
      {visible.map((segment) => {
        const dayTiles = tiles.get(segment.date)
        return (
          <section
            key={segment.date}
            className="absolute inset-x-0"
            style={{ top: segment.top, height: segment.height - options.sectionGap }}
          >
            <header className={DAY_HEADER_CLASS}>
              <h2 className={DAY_HEADING_CLASS}>{formatDayKeyHeading(segment.date)}</h2>
            </header>

            {dayTiles ? (
              <LoadedDay
                tiles={dayTiles}
                options={options}
                selected={selected}
                selecting={selecting}
                selectable={selectable}
                onOpen={onOpen}
                onToggleSelect={onToggleSelect}
              />
            ) : (
              <PlaceholderDay date={segment.date} count={segment.count} options={options} />
            )}
          </section>
        )
      })}
    </div>
  )
}

function LoadedDay({
  tiles,
  options,
  selected,
  selecting,
  selectable,
  onOpen,
  onToggleSelect,
}: {
  tiles: TimelineTile[]
  options: LayoutOptions
  selected: Set<string>
  selecting: boolean
  selectable: boolean
  onOpen: (tile: TimelineTile) => void
  onToggleSelect: (tile: TimelineTile, shiftKey: boolean) => void
}) {
  const rows = useMemo(
    () =>
      justify(
        tiles.map((tile) => ({ id: tile.id, aspect: aspectOf(tile) })),
        { width: options.width, targetHeight: options.targetHeight, gap: options.gap },
      ),
    [tiles, options],
  )

  const byId = useMemo(() => new Map(tiles.map((tile) => [tile.id, tile])), [tiles])
  const last = rows.at(-1)

  return (
    <div style={{ position: 'relative', height: last ? last.top + last.height : 0 }}>
      {rows.map((row) => (
        <div
          key={row.top}
          className="absolute left-0 flex"
          style={{ top: row.top, height: row.height, gap: options.gap }}
        >
          {row.items.map((item) => {
            const tile = byId.get(item.id)
            if (!tile) return null
            return (
              <PhotoTile
                key={item.id}
                asset={tile}
                width={item.width}
                height={item.height}
                selected={selected.has(item.id)}
                selecting={selecting}
                selectable={selectable}
                onOpen={onOpen}
                onToggleSelect={onToggleSelect}
              />
            )
          })}
        </div>
      ))}
    </div>
  )
}

/**
 * A day whose photographs have not arrived, blocked out at the shape the estimate reserved
 * room for. The count is known from the spine, so the number of rows and the number of
 * blocks in them are right; the proportions and the colours are not known, and guessing at
 * those would be inventing photographs.
 */
function PlaceholderDay({
  date,
  count,
  options,
}: {
  date: string
  count: number
  options: LayoutOptions
}) {
  const { perRow, rows } = estimateRowLayout(count, options)
  const width = (options.width - options.gap * (perRow - 1)) / perRow

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'relative',
        height: rows * options.targetHeight + (rows - 1) * options.gap,
      }}
    >
      {/* biome-ignore-start lint/suspicious/noArrayIndexKey: a grid of blanks has nothing else to be keyed by */}
      {Array.from({ length: rows }, (_, row) => (
        <div
          key={`${date}-${row}`}
          className="absolute left-0 flex"
          style={{ top: row * (options.targetHeight + options.gap), gap: options.gap }}
        >
          {Array.from({ length: Math.min(perRow, count - row * perRow) }, (_, cell) => (
            <div
              key={`${date}-${row}-${cell}`}
              className="rounded-[--radius-tile] bg-sunken"
              style={{ width, height: options.targetHeight }}
            />
          ))}
        </div>
      ))}
      {/* biome-ignore-end lint/suspicious/noArrayIndexKey: a grid of blanks has nothing else to be keyed by */}
    </div>
  )
}
