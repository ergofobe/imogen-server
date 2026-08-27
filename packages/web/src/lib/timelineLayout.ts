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
 * evicted and fetched again.
 *
 * Its keys are a layout signature — the date plus everything a stored height depends on —
 * rather than the date alone. A height is only ever read back for the exact count and
 * layout it was computed under, so a resize, a breakpoint change, or a day losing half its
 * photographs to the trash cannot serve a stale height: the signature simply misses and the
 * day is derived afresh. That makes the map safe to hold across renders and to write to
 * during one, since an entry recorded by a render that is later discarded is still correct
 * for its own signature. The caller passes the same map through and never reads it.
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
  const key = layoutSignature(bucket, options)
  const remembered = measured.get(key)
  if (remembered !== undefined) return { height: remembered, measured: true }

  const tiles = loaded.get(bucket.date)
  // A half-fetched day would measure short and lock that in, so only a day holding at least
  // as many tiles as its count counts as measured. `>=` rather than `===` on purpose: a
  // spine that is briefly behind an import reports a low count, and refusing to measure
  // then would leave the day overlapping its neighbour.
  if (tiles && tiles.length >= bucket.count) {
    const height = measureDayHeight(tiles, options)
    // Measured for this frame, but only remembered once every photograph's real dimensions
    // are in. A still-processing upload has no width or height yet and `aspectOf` lays it
    // out at a fallback aspect; when the worker finishes, the true dimensions arrive under
    // an identical signature — same date, same count, same layout — so a guess recorded now
    // would outlive the thing it was guessing about, with no path back.
    if (tiles.every(hasKnownDimensions)) measured.set(key, height)
    return { height, measured: true }
  }

  return { height: estimateDayHeight(bucket.count, options), measured: false }
}

/** The same test `aspectOf` applies before falling back: a processing upload fails it. */
function hasKnownDimensions(tile: TimelineTile): boolean {
  return Boolean(tile.width && tile.height)
}

/**
 * Everything a stored height depends on. Every field below is a summand or a divisor of the
 * result, so a change in any of them makes a remembered height wrong; folding them all into
 * the key retires stale entries by making them unreachable instead of relying on a caller to
 * know when to clear the map. Unreachable entries are left to accumulate, which is bounded
 * by how many distinct layouts a window is ever resized through.
 */
function layoutSignature(bucket: TimelineBucket, options: LayoutOptions): string {
  const { width, targetHeight, gap, sectionGap, headerHeight } = options
  return `${bucket.date}|${bucket.count}|${width}|${targetHeight}|${gap}|${sectionGap}|${headerHeight}`
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

/**
 * What a day of `count` photographs will probably stand at, before any of them are fetched.
 *
 * The gap term is `rows - 1`, not `rows`: `justify` advances by `height + gap` per row and
 * reports `last.top + last.height`, so there is no gap below the final row. Counting one
 * anyway made every day a whole gap taller as an estimate than as a measurement, so each
 * one twitched on resolving even when its row count had been predicted exactly — the very
 * jitter this module exists to prevent.
 */
export function estimateDayHeight(count: number, options: LayoutOptions): number {
  const perRow = Math.max(1, Math.floor(options.width / (options.targetHeight * AVERAGE_ASPECT)))
  const rows = Math.max(1, Math.ceil(count / perRow))
  const grid = rows * options.targetHeight + (rows - 1) * options.gap
  return options.headerHeight + grid + options.sectionGap
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
 * How far to move the scroll position so the photograph under the reader's eye stays there
 * when one table replaces another.
 *
 * It is the shift of a single anchor — the first day at or after `scrollTop` that exists in
 * both tables — plus the reader's own fraction of that day's change in height. Anchoring
 * one day rather than accumulating every change above the reader is what keeps the answer
 * continuous: a day straddling the top of the viewport contributes only the share of itself
 * that is actually above the eye, so resolving it moves the view by a pixel or two instead
 * of by its whole growth. It also needs no separate reasoning for days that appear or
 * disappear — an import above the reader or a day emptied into the trash both simply move
 * the anchor, and they move it in the anchor's own coordinates, so several at once compose
 * correctly where summing next-space tops would drop all but the first.
 *
 * Positive means the timeline above the reader grew and the scroll position must grow with
 * it, so the caller adds: `scroller.scrollTop += delta`.
 *
 * Contract: the caller must clamp the result into `[0, totalHeight - viewportHeight]`. This
 * module cannot — it does not know the viewport height — and a browser silently clamps an
 * out-of-range `scrollTop` assignment, which would let the compensation half-fail with no
 * signal at either end of the timeline.
 */
export function scrollDelta(previous: SegmentTable, next: SegmentTable, scrollTop: number): number {
  const anchor = anchorSegment(previous, next, scrollTop)
  if (!anchor) return 0

  const moved = next.byDate.get(anchor.date)!
  const shift = moved.top - anchor.top
  if (anchor.height <= 0) return shift

  // Inside the anchor day, the reader is some fraction of the way down it, and keeps that
  // fraction as the day resizes. Clamped because the fallback anchor can sit outside it.
  const fraction = Math.min(1, Math.max(0, (scrollTop - anchor.top) / anchor.height))
  return shift + fraction * (moved.height - anchor.height)
}

/** The day the reader is holding on to: at or after `scrollTop`, and still present in `next`. */
function anchorSegment(
  previous: SegmentTable,
  next: SegmentTable,
  scrollTop: number,
): DaySegment | null {
  const { segments } = previous
  const start = firstSegmentEndingAfter(segments, scrollTop)

  for (let i = start; i < segments.length; i++) {
    const segment = segments[i]!
    if (next.byDate.has(segment.date)) return segment
  }
  // Nothing at or below the reader survived — they are past the end of the timeline, or the
  // days beneath them have all been trashed. The nearest surviving day above is the next
  // best thing to hold on to.
  for (let i = Math.min(start, segments.length) - 1; i >= 0; i--) {
    const segment = segments[i]!
    if (next.byDate.has(segment.date)) return segment
  }
  return null
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
