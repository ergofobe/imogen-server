import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { formatDayKeyHeading } from '../lib/format.ts'
import {
  gridTopOf,
  scrollEventSourceFor,
  scrollGridTo,
  scrollingAncestorOf,
} from '../lib/scroller.ts'
import { dateAtOffset, offsetForDate, periodOf, type SegmentTable } from '../lib/timelineLayout.ts'

/**
 * A date rail down the right edge, drawn from the segment table rather than from the
 * calendar.
 *
 * That is the whole idea: the table's heights come from how many photographs each day
 * actually holds, so a year of nine thousand frames owns more rail than a year of two
 * hundred, and dragging through the rail spends time in proportion to how much there is
 * to look at. A calendar-proportional rail would give a fortnight in Corfu the same
 * sliver as the fortnight either side of it, which is the opposite of what a person
 * scrubbing a photo library is looking for.
 */

export type RailTick = {
  /**
   * The calendar key the tick stands for — '2012' or '2012-11' — not display text. The
   * component formats it. Keeping the arithmetic free of `Intl` is what lets the tick
   * placement be tested without a DOM or a locale, which is how the rest of this repo
   * is tested.
   */
  label: string
  y: number
  kind: 'year' | 'month'
  /**
   * Whether there is room to print the label, or only to draw the boundary.
   *
   * A rail proportional to density puts a thin year a few pixels below a dense one, and
   * two labels cannot share those pixels. The loser is demoted rather than discarded: the
   * boundary still shows, so the rail never implies a year holds nothing merely because it
   * had no room to say its name. The rail is allowed to be this incomplete precisely
   * because the overview is not — it lists every year with an exact count and no space
   * pressure at all, which is what the rail hands off to when a reader wants the whole
   * shape rather than a place to aim.
   */
  labelled: boolean
}

/**
 * A year is only worth subdividing once it owns this much rail. Below it the year's own
 * label is all that will fit, and month marks would be decoration rather than a target.
 */
const MONTH_TICK_MIN_YEAR_SPAN = 44

/**
 * No two ticks closer than this, whatever they are ticks of.
 *
 * It applies twice over. Within a year, because a year whose December holds twenty
 * thousand frames and whose other eleven months hold a handful spans plenty of rail while
 * every one of those eleven months lands on the same pixel at the bottom of it. And
 * between years, because a rail proportional to density puts a year of two hundred frames
 * six pixels below a year of nine thousand — and 2018, 2017 and 2016 printed over one
 * another is three labels and no information.
 */
const MIN_TICK_SPACING = 12

/** Long enough that a flick past a month does not fetch it; short enough to feel instant. */
const RESUME_DELAY = 150

const DAY_MS = 86_400_000

/**
 * Where every year — and, where there is room, every month — falls on a rail of a given
 * height. Pure, and the only place the mapping between timeline pixels and rail pixels is
 * written down.
 */
export function railTicks(table: SegmentTable, railHeight: number): RailTick[] {
  const { segments, totalHeight } = table
  // An unmeasured rail, or a table built before the grid had a width, has no honest
  // mapping to report and would divide by zero working one out.
  if (segments.length === 0 || totalHeight <= 0 || railHeight <= 0) return []

  const scale = railHeight / totalHeight
  const ticks: Candidate[] = []

  for (let start = 0; start < segments.length; ) {
    const year = segments[start]!.date.slice(0, 4)
    let end = start
    while (end < segments.length && segments[end]!.date.slice(0, 4) === year) end++

    // Segments run newest first, so a year's first segment is its newest day — the point
    // at which the reader crosses into that year on the way down.
    const top = segments[start]!.top * scale
    const bottom = (end < segments.length ? segments[end]!.top : totalHeight) * scale
    ticks.push({ label: year, y: top, kind: 'year', span: bottom - top, labelled: true })

    if (bottom - top >= MONTH_TICK_MIN_YEAR_SPAN) {
      // Seeded with the year tick, so the newest month — which shares its position — is
      // not marked twice.
      let lastY = top
      for (let i = start + 1; i < end; i++) {
        const month = periodOf(segments[i]!.date)
        if (month === periodOf(segments[i - 1]!.date)) continue
        const y = segments[i]!.top * scale
        if (y - lastY < MIN_TICK_SPACING) continue
        lastY = y
        ticks.push({ label: month, y, kind: 'month', span: 0, labelled: false })
      }
    }

    start = end
  }

  return resolveLabels(ticks)
}

/** A tick plus how much rail its period owns, which is how collisions are settled. */
type Candidate = RailTick & { span: number }

/**
 * Decides which ticks get to print their label. The ticks arrive in ascending `y`, so one
 * pass with a memory of the last label placed is enough.
 *
 * Only labels compete — a bare mark is a line at the right edge and two of them on one
 * pixel are indistinguishable from one, so nothing is dropped for want of room except the
 * text. Between two years that cannot both be named, the one owning more rail wins: the
 * year worth finding, rather than the one that happens to be newer. Taking the newer put
 * the label on a lockdown year of two hundred frames and left the four thousand under it
 * blank.
 */
function resolveLabels(ticks: Candidate[]): RailTick[] {
  const out: Candidate[] = []
  let lastLabelledY = Number.NEGATIVE_INFINITY
  let lastLabelled = -1

  const place = (tick: Candidate) => {
    out.push({ ...tick, labelled: true })
    lastLabelledY = tick.y
    lastLabelled = out.length - 1
  }

  for (const tick of ticks) {
    if (tick.kind === 'month') {
      // A month mark is a subdivision of a year that is already named. One drawn this
      // close would sit behind that year's text, which is noise rather than information.
      if (tick.y - lastLabelledY < MIN_TICK_SPACING) continue
      out.push({ ...tick, labelled: false })
      continue
    }

    if (tick.y - lastLabelledY >= MIN_TICK_SPACING) {
      // A year always outranks a month mark it lands on, so take back the room.
      while (
        out.length > 0 &&
        out.at(-1)!.kind === 'month' &&
        tick.y - out.at(-1)!.y < MIN_TICK_SPACING
      ) {
        out.pop()
      }
      place(tick)
      continue
    }

    const holder = lastLabelled >= 0 ? out[lastLabelled] : undefined
    if (holder && holder.kind === 'year' && tick.span > holder.span) {
      holder.labelled = false
      place(tick)
      continue
    }
    out.push({ ...tick, labelled: false })
  }

  return out.map(({ label, y, kind, labelled }) => ({ label, y, kind, labelled }))
}

type Props = {
  table: SegmentTable
  /**
   * The grid element, so the rail writes into the same scroller and the same coordinate
   * space `PhotoGrid` reads out of. The rail is `position: fixed` and so has no scrolling
   * ancestor of its own to find; asking the grid is the only way to be sure both are
   * talking about the same pixels.
   */
  grid: HTMLElement | null
  suspendFetching: (suspended: boolean) => void
}

/**
 * Who owns the scroll position.
 *
 * `PhotoGrid` writes it in a layout effect whenever a day's estimated height is replaced
 * by a measured one, to keep the photograph under the reader's eye where it was. The rail
 * writes it while a pointer is down on it. They look like they must fight, and they do not
 * — but not for the reason it is tempting to give.
 *
 * The tempting reason is that a drag suspends fetching, so nothing arrives, so no day
 * resolves and there is nothing to compensate for. That is not true, and it is worth
 * saying why rather than quietly relying on it. Suspension gates `periods.load` and the
 * settling interval, but `useTimeline`'s reconciliation effect — the one that refetches a
 * month the spine now disagrees with — is keyed on the buckets alone and has no such
 * guard. A spine request already in the air at pointerdown can land mid-drag, and bucket
 * requests can follow it. The table can change under a suspended drag.
 *
 * The reason it does not matter is in what the compensation actually computes. It anchors
 * on the first day at or after the current scroll position — which, mid-drag, is the day
 * the rail itself wrote a moment ago — and moves the scroll position to keep that day
 * under the reader. So it preserves the date the reader is aiming at and adjusts only the
 * pixel it lives at. It cannot move the rail off the reader's target, because the target
 * is what it is holding on to. And the next pointer move re-asserts the pointer's position
 * regardless.
 *
 * So the rail does not suppress the compensation and does not need to know about it. It
 * simply writes last, sixty times a second, for as long as the reader is holding on.
 */
export function TimelineRail({ table, grid, suspendFetching }: Props) {
  const [rail, setRail] = useState<HTMLDivElement | null>(null)
  const [railHeight, setRailHeight] = useState(0)
  const [gridTop, setGridTop] = useState(0)
  const [scrubbing, setScrubbing] = useState(false)

  const dragging = useRef(false)
  const resuming = useRef<ReturnType<typeof setTimeout> | null>(null)

  // A callback ref for the same reason `useGridLayout` uses one: the route renders a
  // skeleton first, so an observer attached on the first commit would find nothing and
  // never look again.
  useLayoutEffect(() => {
    if (!rail) return
    const observer = new ResizeObserver(([entry]) => setRailHeight(entry?.contentRect.height ?? 0))
    observer.observe(rail)
    return () => observer.disconnect()
  }, [rail])

  useEffect(() => {
    if (!grid) return
    const scroller = scrollingAncestorOf(grid)

    let frame = 0
    const read = () => {
      frame = 0
      setGridTop(gridTopOf(grid))
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read)
    }
    read()

    const source = scrollEventSourceFor(scroller)
    source.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      source.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [grid])

  /*
   * A new table means new geometry under an unchanged scroll position, and `PhotoGrid` may
   * have just moved that position to compensate. Reading here — after its layout effect,
   * since the rail is rendered below the grid — puts the thumb where the reader now is
   * without waiting for the scroll event that write will eventually produce.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new table is the trigger, not a value read
  useLayoutEffect(() => {
    if (grid) setGridTop(gridTopOf(grid))
  }, [grid, table])

  // Never leave the window suspended because the rail unmounted mid-drag.
  useEffect(
    () => () => {
      if (resuming.current) clearTimeout(resuming.current)
      if (dragging.current) suspendFetching(false)
    },
    [suspendFetching],
  )

  const scrubTo = useCallback(
    (clientY: number) => {
      if (!rail || !grid || table.totalHeight <= 0) return
      const box = rail.getBoundingClientRect()
      if (box.height <= 0) return
      const y = Math.min(box.height, Math.max(0, clientY - box.top))
      scrollGridTo(grid, (y / box.height) * table.totalHeight)
      // Read back rather than trusting the target: `scrollGridTo` clamps at both ends, and
      // a label reporting a date the view never reached is worse than no label.
      setGridTop(gridTopOf(grid))
    },
    [rail, grid, table.totalHeight],
  )

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      if (resuming.current) {
        clearTimeout(resuming.current)
        resuming.current = null
      }
      dragging.current = true
      setScrubbing(true)
      // Before the first move, not after: a drag from this year to 2004 crosses fifteen
      // years of months, and every one of them would be requested and thrown away.
      suspendFetching(true)
      scrubTo(event.clientY)
    },
    [scrubTo, suspendFetching],
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return
      scrubTo(event.clientY)
    },
    [scrubTo],
  )

  const endDrag = useCallback(() => {
    if (!dragging.current) return
    dragging.current = false
    setScrubbing(false)
    // After a beat rather than at once. A reader who lands, looks, and moves on should not
    // pay for the month they passed through on the way to the one they wanted.
    resuming.current = setTimeout(() => {
      resuming.current = null
      suspendFetching(false)
    }, RESUME_DELAY)
  }, [suspendFetching])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (!grid) return
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      event.preventDefault()
      // Not suspended: a single step lands somewhere the reader means to look at, and the
      // month under them is exactly the one worth fetching.
      scrollGridTo(grid, stepMonth(table, gridTop, event.key === 'ArrowUp' ? 1 : -1))
      setGridTop(gridTopOf(grid))
    },
    [grid, table, gridTop],
  )

  const ticks = railTicks(table, railHeight)
  const date = dateAtOffset(table, gridTop)

  /*
   * Whether there is anything to scrub: a library with days in it, taller than the screen
   * it is being read on, on a rail that has been measured.
   *
   * What this deliberately does *not* do is return null when the answer is no. The rail's
   * height comes from observing the rail, so refusing to render an unmeasured rail leaves
   * nothing to observe, and it stays unmeasured, and so it never renders — a blank that
   * feeds itself and that no test without a DOM can see. The strip is always in the
   * document; only what is drawn on it, and whether it answers to a pointer, is
   * conditional. Its geometry is fixed to the viewport and owes nothing to its contents,
   * so an empty one measures exactly as a full one does.
   */
  const usable = ticks.length > 0 && date !== null && table.totalHeight > railHeight

  const thumbY = Math.min(railHeight, Math.max(0, (gridTop / table.totalHeight) * railHeight))
  const newest = table.segments[0]?.date
  const oldest = table.segments.at(-1)?.date

  return (
    // The shell is what gets measured, and it is always here. Its box is fixed to the
    // viewport, so it measures the same whether or not there is a slider inside it.
    <div
      ref={setRail}
      className="pointer-events-none fixed top-0 right-0 bottom-16 z-20 w-11 md:bottom-0"
    >
      {usable && date && newest && oldest && (
        <div
          role="slider"
          tabIndex={0}
          aria-label="Scrub the timeline by date"
          aria-orientation="vertical"
          // In days, because that is the unit the timeline is bucketed in — and ascending
          // with newness, so the arrow that moves the view up also raises the value.
          aria-valuemin={dayNumber(oldest)}
          aria-valuemax={dayNumber(newest)}
          aria-valuenow={dayNumber(date)}
          aria-valuetext={formatDayKeyHeading(date)}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKeyDown}
          className="pointer-events-auto absolute inset-0 cursor-ns-resize touch-none select-none border-line/60 border-l bg-paper/70 backdrop-blur-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-safelight"
        >
          {ticks.map((tick) => (
            <div
              key={`${tick.kind}-${tick.label}`}
              aria-hidden="true"
              className="pointer-events-none absolute right-0"
              style={{ top: tick.y }}
            >
              {tick.labelled ? (
                <span className="label-micro -translate-y-1/2 block pr-1.5 text-muted">
                  {tick.label}
                </span>
              ) : (
                <span className="block h-px w-2 bg-line" />
              )}
            </div>
          ))}

          {/* The reader's own position. Drawn over the ticks, and always visible, so the
              rail answers "where am I" as well as "where can I go". */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-0 h-0.5 w-full bg-safelight"
            style={{ top: thumbY }}
          />

          {scrubbing && (
            <span
              aria-hidden="true"
              className="surface-panel pointer-events-none absolute right-[calc(100%+8px)] -translate-y-1/2 whitespace-nowrap rounded-full px-3 py-1.5 text-sm"
              style={{ top: thumbY }}
            >
              {formatDayKeyHeading(date)}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * A UTC day key as a day number, which is what `aria-valuenow` needs it to be.
 *
 * Exported for the same reason `railTicks` is: it is arithmetic over dates, and this repo
 * tests arithmetic without a DOM.
 */
export function dayNumber(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00.000Z`) / DAY_MS)
}

/**
 * One month up or down the timeline, in grid coordinates. `step` is +1 for later — which
 * is up the page, since the timeline runs newest first.
 *
 * "One month" means the next month that *exists*, found by asking the sorted table rather
 * than by counting calendar months and hoping one of them is occupied. An earlier version
 * walked the calendar and gave up after twenty-four misses, falling back to either end of
 * the library — so at the edge of any gap longer than two years, and a twenty-year library
 * is full of them, one arrow keypress teleported the reader to 2026 or to their oldest
 * photograph. The opposite of aiming, in the one control built for aiming.
 *
 * Both directions are two binary searches and no iteration, so a gap of one month and a
 * gap of eleven years cost exactly the same.
 */
export function stepMonth(table: SegmentTable, from: number, step: 1 | -1): number {
  const date = dateAtOffset(table, from)
  if (!date) return from
  const month = periodOf(date)
  const top = monthTop(table, month)

  if (step < 0) {
    /*
     * `-00` is a comparison sentinel, not a date. It sorts after every real day of the
     * month before this one and before every day of this one, so "the newest day at or
     * before it" is the newest day of the next month that holds anything — however many
     * empty years lie between.
     */
    const older = offsetForDate(table, `${month}-00`)
    const olderDate = dateAtOffset(table, older)
    // Nothing older: the sentinel fell off the end and came back with a day of this same
    // month. There is no month below this one, so the key does nothing rather than leaping.
    return olderDate && periodOf(olderDate) !== month ? older : from
  }

  // Already in the newest month there is; the most that can be asked for is its top.
  if (top <= 0) return 0
  // One pixel above this month's top belongs to the last day of the month above it.
  const newer = dateAtOffset(table, top - 1)
  return newer ? monthTop(table, periodOf(newer)) : 0
}

/**
 * Where a month begins. `-31` is the mirror of the sentinel above: every real day of a
 * month sorts before its thirty-first, so this finds that month's newest day whatever
 * days it actually holds.
 */
function monthTop(table: SegmentTable, month: string): number {
  return offsetForDate(table, `${month}-31`)
}
