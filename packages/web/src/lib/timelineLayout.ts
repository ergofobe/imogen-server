import type { TimelineBucket, TimelineTile } from '@imogen/shared'
import { aspectOf, justify } from './justify.ts'

/**
 * The geometry of the whole timeline, worked out from day counts alone so the scroller
 * is the right height from the first paint and a date rail can be proportional to real
 * photograph density. Pure — no React, no DOM, no fetching — which is what makes the
 * awkward cases (a forty-thousand-photograph day, a zero-width container, a bucket
 * arriving mid-import) testable without a browser.
 */

/**
 * Close to the mix of 3:2 and 4:3 a camera roll actually holds. Estimating with it is
 * wrong for any single photograph and close enough over a day's worth, which is all an
 * estimate has to be: it is replaced by a real measurement the moment tiles arrive.
 */
const AVERAGE_ASPECT = 1.4

export type DaySegment = {
  date: string
  count: number
  top: number
  height: number
  /** False while the height is an estimate rather than a justify pass over real tiles. */
  measured: boolean
}

export type SegmentTable = {
  /** Newest first, matching the bucket order the server returns, and so sorted by `top`. */
  segments: DaySegment[]
  byDate: Map<string, DaySegment>
  totalHeight: number
}

export type LayoutOptions = {
  width: number
  targetHeight: number
  gap: number
  sectionGap: number
  headerHeight: number
}

/**
 * Places every bucket head to tail.
 *
 * `measured` is both an input and where newly learned heights are recorded: a height is
 * derived once and kept for good, so a region visited once stays put when its tiles are
 * evicted and fetched again. It is keyed by date alone, so it holds only for the `width`
 * it was learned at — the caller must clear it when the container resizes.
 */
export function buildSegments(
  buckets: TimelineBucket[],
  loaded: Map<string, TimelineTile[]>,
  options: LayoutOptions,
  measured: Map<string, number>,
): SegmentTable {
  const segments: DaySegment[] = []
  const byDate = new Map<string, DaySegment>()
  // A ResizeObserver fires with zero width before first layout; there is no honest
  // geometry to report yet, and every row calculation would divide by it.
  if (options.width <= 0) return { segments, byDate, totalHeight: 0 }

  let top = 0
  for (const bucket of buckets) {
    const resolved = resolveDayHeight(bucket, loaded, options, measured)
    const segment: DaySegment = {
      date: bucket.date,
      count: bucket.count,
      top,
      height: resolved.height,
      measured: resolved.measured,
    }
    segments.push(segment)
    byDate.set(segment.date, segment)
    top += segment.height
  }

  return { segments, byDate, totalHeight: top }
}

function resolveDayHeight(
  bucket: TimelineBucket,
  loaded: Map<string, TimelineTile[]>,
  options: LayoutOptions,
  measured: Map<string, number>,
): { height: number; measured: boolean } {
  const remembered = measured.get(bucket.date)
  if (remembered !== undefined) return { height: remembered, measured: true }

  const tiles = loaded.get(bucket.date)
  // A half-fetched day would measure short and lock that in forever, so only a day whose
  // tiles are all present counts as measured.
  if (tiles && tiles.length >= bucket.count) {
    const height = measureDayHeight(tiles, options)
    measured.set(bucket.date, height)
    return { height, measured: true }
  }

  return { height: estimateDayHeight(bucket.count, options), measured: false }
}

/** The exact height of a day, through the same justify pass that draws it. */
function measureDayHeight(tiles: TimelineTile[], options: LayoutOptions): number {
  const rows = justify(
    tiles.map((tile) => ({ id: tile.id, aspect: aspectOf(tile) })),
    { width: options.width, targetHeight: options.targetHeight, gap: options.gap },
  )
  const last = rows.at(-1)
  const grid = last ? last.top + last.height : 0
  return options.headerHeight + grid + options.sectionGap
}

export function estimateDayHeight(count: number, options: LayoutOptions): number {
  const perRow = Math.max(1, Math.floor(options.width / (options.targetHeight * AVERAGE_ASPECT)))
  const rows = Math.max(1, Math.ceil(count / perRow))
  return options.headerHeight + rows * (options.targetHeight + options.gap) + options.sectionGap
}

/** The days a window touches, in timeline order. */
export function segmentsInRange(table: SegmentTable, top: number, bottom: number): DaySegment[] {
  const { segments } = table
  const visible: DaySegment[] = []
  for (let i = firstSegmentEndingAfter(segments, top); i < segments.length; i++) {
    const segment = segments[i]!
    if (segment.top >= bottom) break
    visible.push(segment)
  }
  return visible
}

/**
 * How far to move the scroll position so the photograph under the reader's eye stays
 * there when a table is replaced.
 *
 * Only what sits *above* the viewport moves it: a day whose estimate is replaced by a
 * taller measurement pushes everything below it down, so the scroll position must grow
 * by the same amount to compensate. Hence `next - previous`, positive when the timeline
 * above grew, and hence the caller adding it to `scrollTop`. Changes below the reader
 * cost nothing, which is why they are skipped rather than merely cancelling out.
 */
export function scrollDelta(previous: SegmentTable, next: SegmentTable, scrollTop: number): number {
  let delta = 0

  for (const segment of next.segments) {
    const before = previous.byDate.get(segment.date)
    // A day that did not exist before — an import landing at the top of the library —
    // adds its whole height above the reader.
    if (!before) {
      if (segment.top < scrollTop) delta += segment.height
      continue
    }
    if (before.top < scrollTop) delta += segment.height - before.height
  }

  // And a day that has gone — its last photograph trashed — takes its height with it.
  for (const before of previous.segments) {
    if (before.top < scrollTop && !next.byDate.has(before.date)) delta -= before.height
  }

  return delta
}

/** The day at a pixel offset, clamped to the ends rather than reporting nothing. */
export function dateAtOffset(table: SegmentTable, offset: number): string | null {
  const { segments } = table
  if (segments.length === 0) return null
  const index = lastSegmentStartingAtOrBefore(segments, offset)
  return segments[Math.max(0, index)]!.date
}

/**
 * Where a date sits. A date with no photographs — the rail can be dragged to any day of
 * the year — reports the start of the first day at or before it, which is where the
 * timeline would show that moment.
 */
export function offsetForDate(table: SegmentTable, date: string): number {
  const { segments } = table
  if (segments.length === 0) return 0
  const exact = table.byDate.get(date)
  if (exact) return exact.top

  let low = 0
  let high = segments.length
  while (low < high) {
    const middle = (low + high) >>> 1
    // Dates run newest first, so this walks towards the first day no newer than `date`.
    if (segments[middle]!.date > date) low = middle + 1
    else high = middle
  }
  return segments[Math.min(low, segments.length - 1)]!.top
}

/** '2011-08-14' -> '2011-08'. Periods are the unit a month of tiles is fetched in. */
export function periodOf(date: string): string {
  return date.slice(0, 7)
}

/**
 * Splits tiles into UTC days, the same slice `groupByDay` takes and the same boundary the
 * server buckets on — the agreement is what lets a bucket's count size a day's height.
 */
export function groupTilesByDay(tiles: TimelineTile[]): Map<string, TimelineTile[]> {
  const days = new Map<string, TimelineTile[]>()
  for (const tile of tiles) {
    const date = tile.capturedAt.slice(0, 10)
    const day = days.get(date)
    if (day) day.push(tile)
    else days.set(date, [tile])
  }
  return days
}

/** Lowest index whose bottom edge is past `offset`. Segments are contiguous and ascending. */
function firstSegmentEndingAfter(segments: DaySegment[], offset: number): number {
  let low = 0
  let high = segments.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const segment = segments[middle]!
    if (segment.top + segment.height <= offset) low = middle + 1
    else high = middle
  }
  return low
}

/** Highest index starting at or before `offset`, or -1 when `offset` precedes them all. */
function lastSegmentStartingAtOrBefore(segments: DaySegment[], offset: number): number {
  let low = 0
  let high = segments.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >>> 1
    if (segments[middle]!.top <= offset) {
      found = middle
      low = middle + 1
    } else high = middle - 1
  }
  return found
}
