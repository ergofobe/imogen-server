import { describe, expect, test } from 'bun:test'
import type { TimelineBucket, TimelineTile } from '@imogen/shared'
import { aspectOf, justify } from './justify.ts'
import {
  buildSegments,
  dateAtOffset,
  estimateDayHeight,
  groupTilesByDay,
  type LayoutOptions,
  offsetForDate,
  periodOf,
  scrollDelta,
  segmentsInRange,
} from './timelineLayout.ts'

const OPTIONS: LayoutOptions = {
  width: 1200,
  targetHeight: 208,
  gap: 4,
  sectionGap: 44,
  headerHeight: 40,
}

const bucket = (date: string, count: number): TimelineBucket => ({
  date,
  count,
  coverAssetId: null,
})

const tile = (
  id: string,
  capturedAt: string,
  width: number | null = 4032,
  height: number | null = 3024,
): TimelineTile => ({
  id,
  capturedAt,
  width,
  height,
  type: 'image',
  status: 'ready',
  favorite: false,
  duration: null,
  placeholderColor: '#3b5f7a',
  livePhotoVideoId: null,
})

const photographs = (date: string, count: number, width?: number | null, height?: number | null) =>
  Array.from({ length: count }, (_, i) =>
    tile(`${date}-${i}`, `${date}T09:00:00.000Z`, width, height),
  )

/**
 * A day of panoramas justifies to one photograph per row, so it measures far taller than an
 * estimate built on an average aspect — the estimate-to-measurement jump this module exists
 * to absorb, produced the way production produces it rather than by seeding a height.
 */
const panoramas = (date: string, count: number) => photographs(date, count, 6000, 1000)

/** Uploaded, not yet processed: the worker has not read their dimensions off the file. */
const stillProcessing = (date: string, count: number) => photographs(date, count, null, null)

const DAY_IN_MILLISECONDS = 86_400_000

/** Newest first, the order the server hands buckets back in. */
const descendingDays = (count: number, from = Date.UTC(2020, 0, 1)) =>
  Array.from({ length: count }, (_, i) =>
    new Date(from - i * DAY_IN_MILLISECONDS).toISOString().slice(0, 10),
  )

describe('buildSegments', () => {
  test('lays every bucket out head to tail with no gaps or overlaps', () => {
    const table = buildSegments(
      [bucket('2011-08-15', 10), bucket('2011-08-14', 3), bucket('2011-08-13', 40)],
      new Map(),
      OPTIONS,
      new Map(),
    )
    expect(table.segments[0]!.top).toBe(0)
    for (let i = 1; i < table.segments.length; i++) {
      const previous = table.segments[i - 1]!
      expect(table.segments[i]!.top).toBe(previous.top + previous.height)
    }
    const last = table.segments.at(-1)!
    expect(table.totalHeight).toBe(last.top + last.height)
  })

  test('a day with more photographs is taller than a day with fewer', () => {
    const table = buildSegments(
      [bucket('2011-08-15', 100), bucket('2011-08-14', 2)],
      new Map(),
      OPTIONS,
      new Map(),
    )
    expect(table.segments[0]!.height).toBeGreaterThan(table.segments[1]!.height)
  })

  test('an unloaded day is an estimate; a loaded one is measured', () => {
    const loaded = new Map([['2011-08-14', [tile('a', '2011-08-14T09:00:00.000Z')]]])
    const table = buildSegments(
      [bucket('2011-08-15', 10), bucket('2011-08-14', 1)],
      loaded,
      OPTIONS,
      new Map(),
    )
    expect(table.byDate.get('2011-08-15')!.measured).toBe(false)
    expect(table.byDate.get('2011-08-14')!.measured).toBe(true)
  })

  test('a measured height survives its tiles being evicted', () => {
    const measured = new Map<string, number>()
    const loaded = new Map([['2011-08-14', photographs('2011-08-14', 12)]])
    const withTiles = buildSegments([bucket('2011-08-14', 12)], loaded, OPTIONS, measured)
    const evicted = buildSegments([bucket('2011-08-14', 12)], new Map(), OPTIONS, measured)

    expect(evicted.byDate.get('2011-08-14')!.height).toBe(
      withTiles.byDate.get('2011-08-14')!.height,
    )
    expect(evicted.byDate.get('2011-08-14')!.measured).toBe(true)
    // And not merely because the estimate happens to agree with the measurement.
    expect(evicted.byDate.get('2011-08-14')!.height).not.toBe(estimateDayHeight(12, OPTIONS))
  })

  test('an empty library has no height and no segments', () => {
    const table = buildSegments([], new Map(), OPTIONS, new Map())
    expect(table.segments).toHaveLength(0)
    expect(table.totalHeight).toBe(0)
  })

  test('a day of forty thousand photographs produces a finite, ordered height', () => {
    const table = buildSegments([bucket('2011-08-14', 40_000)], new Map(), OPTIONS, new Map())
    expect(Number.isFinite(table.totalHeight)).toBe(true)
    expect(table.totalHeight).toBeGreaterThan(40_000)
  })

  test('a zero width yields no layout rather than dividing by it', () => {
    const table = buildSegments(
      [bucket('2011-08-14', 10)],
      new Map(),
      { ...OPTIONS, width: 0 },
      new Map(),
    )
    expect(table.totalHeight).toBe(0)
  })
})

describe('estimateDayHeight', () => {
  test('includes the header and at least one row for a single photograph', () => {
    expect(estimateDayHeight(1, OPTIONS)).toBeGreaterThan(
      OPTIONS.headerHeight + OPTIONS.targetHeight,
    )
  })

  // Pinned to the arithmetic, not to itself: at 1200 wide an average aspect of 1.4 fits four
  // photographs to a row, so four is one row and five is two, and a row's worth of gap only
  // ever appears *between* rows. Every one of those three claims can break silently.
  test('is exactly a header, its rows, the gaps between them, and the section gap', () => {
    expect(estimateDayHeight(1, OPTIONS)).toBe(40 + 208 + 44)
    expect(estimateDayHeight(4, OPTIONS)).toBe(40 + 208 + 44)
    expect(estimateDayHeight(5, OPTIONS)).toBe(40 + (2 * 208 + 4) + 44)
    expect(estimateDayHeight(12, OPTIONS)).toBe(40 + (3 * 208 + 2 * 4) + 44)
  })

  test('does not count a gap below the final row, the way justify does not draw one', () => {
    const oneRow = estimateDayHeight(4, OPTIONS)
    const twoRows = estimateDayHeight(8, OPTIONS)
    expect(twoRows - oneRow).toBe(OPTIONS.targetHeight + OPTIONS.gap)
  })
})

describe('measuring a day', () => {
  test('is exactly the justify pass that draws it, plus the header and the section gap', () => {
    const tiles = photographs('2011-08-14', 12)
    const rows = justify(
      tiles.map((t) => ({ id: t.id, aspect: aspectOf(t) })),
      { width: OPTIONS.width, targetHeight: OPTIONS.targetHeight, gap: OPTIONS.gap },
    )
    const last = rows.at(-1)!
    const table = buildSegments(
      [bucket('2011-08-14', 12)],
      new Map([['2011-08-14', tiles]]),
      OPTIONS,
      new Map(),
    )
    expect(table.byDate.get('2011-08-14')!.height).toBe(
      OPTIONS.headerHeight + last.top + last.height + OPTIONS.sectionGap,
    )
  })

  test('a day fetched only in part stays an estimate rather than measuring short', () => {
    const loaded = new Map([['2011-08-14', [tile('a', '2011-08-14T09:00:00.000Z')]]])
    const table = buildSegments([bucket('2011-08-14', 60)], loaded, OPTIONS, new Map())
    expect(table.byDate.get('2011-08-14')!.measured).toBe(false)
    expect(table.byDate.get('2011-08-14')!.height).toBe(estimateDayHeight(60, OPTIONS))
  })

  test('a remembered height wins over the tiles currently in hand', () => {
    const measured = new Map<string, number>()
    const first = buildSegments(
      [bucket('2011-08-14', 12)],
      new Map([['2011-08-14', photographs('2011-08-14', 12)]]),
      OPTIONS,
      measured,
    )
    const second = buildSegments(
      [bucket('2011-08-14', 12)],
      new Map([['2011-08-14', panoramas('2011-08-14', 12)]]),
      OPTIONS,
      measured,
    )
    expect(second.byDate.get('2011-08-14')!.height).toBe(first.byDate.get('2011-08-14')!.height)
  })

  test('a day that loses half its photographs is measured afresh, not remembered', () => {
    const measured = new Map<string, number>()
    const sixty = photographs('2011-08-14', 60)
    const before = buildSegments(
      [bucket('2011-08-14', 60)],
      new Map([['2011-08-14', sixty]]),
      OPTIONS,
      measured,
    )
    // The user trashes thirty; the spine comes back with a count of thirty and thirty tiles.
    // Serving the remembered height here would leave a permanent blank band below them.
    const after = buildSegments(
      [bucket('2011-08-14', 30)],
      new Map([['2011-08-14', sixty.slice(0, 30)]]),
      OPTIONS,
      measured,
    )
    expect(after.byDate.get('2011-08-14')!.height).toBeLessThan(
      before.byDate.get('2011-08-14')!.height,
    )
  })

  test('a day still being processed is measured for now but never remembered', () => {
    const measured = new Map<string, number>()
    const guessed = buildSegments(
      [bucket('2011-08-14', 10)],
      new Map([['2011-08-14', stillProcessing('2011-08-14', 10)]]),
      OPTIONS,
      measured,
    )
    // The tiles that do have dimensions still lay out correctly, and the section is drawn
    // from this very justify pass, so the height is right for this frame.
    expect(guessed.byDate.get('2011-08-14')!.measured).toBe(true)
    // But nothing is recorded: the signature will be identical once the worker finishes.
    expect(measured.size).toBe(0)

    const ready = buildSegments(
      [bucket('2011-08-14', 10)],
      new Map([['2011-08-14', panoramas('2011-08-14', 10)]]),
      OPTIONS,
      measured,
    )
    expect(ready.byDate.get('2011-08-14')!.height).not.toBe(
      guessed.byDate.get('2011-08-14')!.height,
    )
    expect(measured.size).toBe(1)
  })

  test('one photograph still processing is enough to withhold the whole day', () => {
    const measured = new Map<string, number>()
    const mixed = [...photographs('2011-08-14', 9), ...stillProcessing('2011-08-14', 1)]
    buildSegments([bucket('2011-08-14', 10)], new Map([['2011-08-14', mixed]]), OPTIONS, measured)
    expect(measured.size).toBe(0)
  })

  test('a day is measured afresh when the section gap changes', () => {
    const measured = new Map<string, number>()
    const loaded = new Map([['2011-08-14', photographs('2011-08-14', 12)]])
    const tight = buildSegments([bucket('2011-08-14', 12)], loaded, OPTIONS, measured)
    const loose = buildSegments(
      [bucket('2011-08-14', 12)],
      loaded,
      { ...OPTIONS, sectionGap: 80 },
      measured,
    )
    expect(loose.byDate.get('2011-08-14')!.height).toBe(
      tight.byDate.get('2011-08-14')!.height + (80 - OPTIONS.sectionGap),
    )
  })

  test('a day is measured afresh when the header height changes', () => {
    const measured = new Map<string, number>()
    const loaded = new Map([['2011-08-14', photographs('2011-08-14', 12)]])
    const short = buildSegments([bucket('2011-08-14', 12)], loaded, OPTIONS, measured)
    const tall = buildSegments(
      [bucket('2011-08-14', 12)],
      loaded,
      { ...OPTIONS, headerHeight: 72 },
      measured,
    )
    expect(tall.byDate.get('2011-08-14')!.height).toBe(
      short.byDate.get('2011-08-14')!.height + (72 - OPTIONS.headerHeight),
    )
  })

  test('a resize re-derives rather than serving a height learned at another width', () => {
    const measured = new Map<string, number>()
    const loaded = new Map([['2011-08-14', photographs('2011-08-14', 12)]])
    const wide = buildSegments([bucket('2011-08-14', 12)], loaded, OPTIONS, measured)
    const narrow = buildSegments(
      [bucket('2011-08-14', 12)],
      loaded,
      { ...OPTIONS, width: 600, targetHeight: 132 },
      measured,
    )
    expect(narrow.byDate.get('2011-08-14')!.height).not.toBe(wide.byDate.get('2011-08-14')!.height)
    expect(narrow.byDate.get('2011-08-14')!.measured).toBe(true)
  })
})

describe('segmentsInRange', () => {
  test('returns only what the window touches, plus nothing else', () => {
    const table = buildSegments(
      Array.from({ length: 50 }, (_, i) =>
        bucket(`2011-08-${String(50 - i).padStart(2, '0')}`, 10),
      ),
      new Map(),
      OPTIONS,
      new Map(),
    )
    const visible = segmentsInRange(table, 1000, 2000)
    expect(visible.length).toBeGreaterThan(0)
    expect(visible.length).toBeLessThan(table.segments.length)
    for (const segment of visible) {
      expect(segment.top).toBeLessThan(2000)
      expect(segment.top + segment.height).toBeGreaterThan(1000)
    }
  })

  test('a window past the end returns nothing rather than throwing', () => {
    const table = buildSegments([bucket('2011-08-14', 3)], new Map(), OPTIONS, new Map())
    expect(segmentsInRange(table, 1_000_000, 1_001_000)).toHaveLength(0)
  })
})

describe('scrollDelta', () => {
  const twoDays = [bucket('2011-08-15', 10), bucket('2011-08-14', 10)]

  test('is zero when what changed is below the viewport', () => {
    const before = buildSegments(twoDays, new Map(), OPTIONS, new Map())
    const after = buildSegments(
      twoDays,
      new Map([['2011-08-14', panoramas('2011-08-14', 10)]]),
      OPTIONS,
      new Map(),
    )
    expect(after.byDate.get('2011-08-14')!.height).not.toBe(before.byDate.get('2011-08-14')!.height)
    expect(scrollDelta(before, after, 0)).toBe(0)
  })

  test('is the accumulated change when it happened above the viewport', () => {
    const before = buildSegments(twoDays, new Map(), OPTIONS, new Map())
    const after = buildSegments(
      twoDays,
      new Map([['2011-08-15', panoramas('2011-08-15', 10)]]),
      OPTIONS,
      new Map(),
    )
    const grew = after.byDate.get('2011-08-15')!.height - before.byDate.get('2011-08-15')!.height
    expect(grew).toBeGreaterThan(0)
    expect(scrollDelta(before, after, 5000)).toBe(grew)
  })

  test('a bucket appearing above the viewport during an import counts too', () => {
    const before = buildSegments([bucket('2011-08-14', 10)], new Map(), OPTIONS, new Map())
    const after = buildSegments(
      [bucket('2011-08-15', 10), bucket('2011-08-14', 10)],
      new Map(),
      OPTIONS,
      new Map(),
    )
    expect(scrollDelta(before, after, 5000)).toBe(after.byDate.get('2011-08-15')!.height)
  })
})

describe('scrollDelta keeps the same photograph under the reader', () => {
  const threeDays = [bucket('2011-08-15', 10), bucket('2011-08-14', 10), bucket('2011-08-13', 10)]
  const twoDaysStraddle = [bucket('2011-08-15', 10), bucket('2011-08-14', 10)]

  // The invariant the whole thing exists for: whatever the day being read moves by, the
  // scroll position must move by the same amount and in the same direction. An inverted
  // sign fails this even though its magnitude is right.
  const shiftOfTheDayBeingRead = (topDay: TimelineTile[]) => {
    const before = buildSegments(threeDays, new Map(), OPTIONS, new Map())
    const scrollTop = before.byDate.get('2011-08-13')!.top + 10
    const after = buildSegments(threeDays, new Map([['2011-08-15', topDay]]), OPTIONS, new Map())
    const moved = after.byDate.get('2011-08-13')!.top - before.byDate.get('2011-08-13')!.top
    return { moved, delta: scrollDelta(before, after, scrollTop) }
  }

  test('a day above growing pushes the reader down by exactly as much', () => {
    const { moved, delta } = shiftOfTheDayBeingRead(panoramas('2011-08-15', 10))
    expect(moved).toBeGreaterThan(0)
    expect(delta).toBe(moved)
  })

  test('a day above shrinking pulls the reader up, not down', () => {
    const { moved, delta } = shiftOfTheDayBeingRead(photographs('2011-08-15', 10))
    expect(moved).toBeLessThan(0)
    expect(delta).toBe(moved)
  })

  test('a day trashed above the viewport gives its height back', () => {
    const before = buildSegments(threeDays, new Map(), OPTIONS, new Map())
    const after = buildSegments(threeDays.slice(1), new Map(), OPTIONS, new Map())
    expect(scrollDelta(before, after, 5000)).toBe(-before.byDate.get('2011-08-15')!.height)
  })

  test('two identical tables ask for no compensation at all', () => {
    const before = buildSegments(threeDays, new Map(), OPTIONS, new Map())
    const after = buildSegments(threeDays, new Map(), OPTIONS, new Map())
    expect(scrollDelta(before, after, 5000)).toBe(0)
  })

  // The day at the top of the viewport resolving from estimate to measurement is the most
  // common event in the system. The reader is ten pixels into it, so only ten pixels' worth
  // of it is above their eye: they must move by their own share of its growth, not by all of
  // it. Charging the whole day is a jump from nothing to hundreds of pixels across one pixel
  // of scrolling.
  test('a day straddling the top of the viewport moves the reader by their share of it', () => {
    const before = buildSegments(twoDaysStraddle, new Map(), OPTIONS, new Map())
    const estimated = before.byDate.get('2011-08-15')!.height
    const after = buildSegments(
      twoDaysStraddle,
      new Map([['2011-08-15', panoramas('2011-08-15', 10)]]),
      OPTIONS,
      new Map(),
    )
    const grew = after.byDate.get('2011-08-15')!.height - estimated
    const scrollTop = 10

    expect(scrollDelta(before, after, scrollTop)).toBeCloseTo((scrollTop / estimated) * grew, 9)
    expect(scrollDelta(before, after, scrollTop)).toBeLessThan(grew / 50)
  })

  test('and by all of it once they are past its bottom edge', () => {
    const before = buildSegments(twoDaysStraddle, new Map(), OPTIONS, new Map())
    const estimated = before.byDate.get('2011-08-15')!.height
    const after = buildSegments(
      twoDaysStraddle,
      new Map([['2011-08-15', panoramas('2011-08-15', 10)]]),
      OPTIONS,
      new Map(),
    )
    const grew = after.byDate.get('2011-08-15')!.height - estimated
    expect(scrollDelta(before, after, estimated)).toBe(grew)
  })

  // The reader is past the end of the whole timeline, so the anchor is the fallback one
  // above them and their fraction of it is greater than one. Unclamped, that fraction
  // multiplies the anchor's own growth and the view is thrown thousands of pixels.
  test('a reader past the end moves by the growth below them, not a multiple of it', () => {
    const before = buildSegments(twoDaysStraddle, new Map(), OPTIONS, new Map())
    const after = buildSegments(
      twoDaysStraddle,
      new Map([['2011-08-14', panoramas('2011-08-14', 10)]]),
      OPTIONS,
      new Map(),
    )
    const grew = after.byDate.get('2011-08-14')!.height - before.byDate.get('2011-08-14')!.height
    expect(grew).toBeGreaterThan(0)
    // Everything in the library is above them, so the whole growth moves them and no more.
    expect(scrollDelta(before, after, 5000)).toBe(grew)
  })

  // The day the reader was inside has been trashed, so the anchor is the next one down,
  // which starts *below* them: their fraction of it is negative. Unclamped, that subtracts
  // a share of a growth that is entirely beneath their eye.
  test('a reader above the anchor takes no share of its change in height', () => {
    const before = buildSegments(threeDays, new Map(), OPTIONS, new Map())
    const after = buildSegments(
      threeDays.slice(1),
      new Map([['2011-08-14', panoramas('2011-08-14', 10)]]),
      OPTIONS,
      new Map(),
    )
    expect(after.byDate.get('2011-08-14')!.height).not.toBe(before.byDate.get('2011-08-14')!.height)
    expect(scrollDelta(before, after, 10)).toBe(
      after.byDate.get('2011-08-14')!.top - before.byDate.get('2011-08-14')!.top,
    )
  })

  // Each inserted day's position in the new table already includes the ones before it, so
  // gating on next-space tops counts only the first and drops the rest.
  test('three days of an import landing above the reader all count', () => {
    const before = buildSegments([bucket('2011-08-14', 30)], new Map(), OPTIONS, new Map())
    const arrived = ['2011-08-17', '2011-08-16', '2011-08-15']
    const after = buildSegments(
      [...arrived.map((date) => bucket(date, 30)), bucket('2011-08-14', 30)],
      new Map(),
      OPTIONS,
      new Map(),
    )
    const wholeImport = arrived.reduce((sum, date) => sum + after.byDate.get(date)!.height, 0)

    expect(scrollDelta(before, after, 10)).toBe(wholeImport)
    expect(scrollDelta(before, after, 10)).toBe(
      after.byDate.get('2011-08-14')!.top - before.byDate.get('2011-08-14')!.top,
    )
  })
})

describe('dateAtOffset and offsetForDate', () => {
  test('round-trip: the offset of a date lands inside that date', () => {
    const table = buildSegments(
      [bucket('2011-08-15', 10), bucket('2011-08-14', 10), bucket('2011-08-13', 10)],
      new Map(),
      OPTIONS,
      new Map(),
    )
    expect(dateAtOffset(table, offsetForDate(table, '2011-08-14'))).toBe('2011-08-14')
  })

  test('an offset past the end reports the oldest day rather than null', () => {
    const table = buildSegments([bucket('2011-08-14', 3)], new Map(), OPTIONS, new Map())
    expect(dateAtOffset(table, 1_000_000)).toBe('2011-08-14')
  })

  test('an unknown date reports the start of the nearest day that exists', () => {
    const table = buildSegments(
      [bucket('2011-08-15', 3), bucket('2011-08-10', 3)],
      new Map(),
      OPTIONS,
      new Map(),
    )
    expect(offsetForDate(table, '2011-08-12')).toBe(table.byDate.get('2011-08-10')!.top)
  })

  test('an empty table has no date anywhere', () => {
    expect(dateAtOffset(buildSegments([], new Map(), OPTIONS, new Map()), 0)).toBeNull()
  })
})

describe('searching a twenty-year library', () => {
  // Seven thousand days is roughly what twenty years of photography leaves behind.
  const table = buildSegments(
    descendingDays(7000).map((date, i) => bucket(date, (i % 30) + 1)),
    new Map(),
    OPTIONS,
    new Map(),
  )

  test('every offset finds the day that actually contains it', () => {
    for (const segment of [table.segments[0]!, table.segments[3333]!, table.segments.at(-1)!]) {
      expect(dateAtOffset(table, segment.top)).toBe(segment.date)
      expect(dateAtOffset(table, segment.top + segment.height - 1)).toBe(segment.date)
      expect(offsetForDate(table, segment.date)).toBe(segment.top)
    }
  })

  test('a window in the middle agrees with a linear scan', () => {
    const visible = segmentsInRange(table, 400_000, 402_000)
    const scanned = table.segments.filter((s) => s.top < 402_000 && s.top + s.height > 400_000)
    expect(visible.map((s) => s.date)).toEqual(scanned.map((s) => s.date))
  })

  test('an offset before the beginning reports the newest day', () => {
    expect(dateAtOffset(table, -500)).toBe(table.segments[0]!.date)
  })

  test('a date newer than the whole library lands at the top', () => {
    expect(offsetForDate(table, '2099-01-01')).toBe(0)
  })

  test('a date older than the whole library lands on the oldest day', () => {
    expect(offsetForDate(table, '1970-01-01')).toBe(table.segments.at(-1)!.top)
  })
})

describe('periodOf and groupTilesByDay', () => {
  test('a date belongs to its month', () => {
    expect(periodOf('2011-08-14')).toBe('2011-08')
  })

  test('tiles split by UTC day, matching how the server bucketed them', () => {
    const grouped = groupTilesByDay([
      tile('a', '2011-08-14T23:30:00.000Z'),
      tile('b', '2011-08-15T00:30:00.000Z'),
    ])
    expect([...grouped.keys()]).toEqual(['2011-08-14', '2011-08-15'])
  })

  test('keeps every tile of a day together, in the order it arrived', () => {
    const grouped = groupTilesByDay([
      tile('a', '2011-08-15T10:00:00.000Z'),
      tile('b', '2011-08-14T10:00:00.000Z'),
      tile('c', '2011-08-15T09:00:00.000Z'),
    ])
    expect(grouped.get('2011-08-15')!.map((t) => t.id)).toEqual(['a', 'c'])
    expect(grouped.get('2011-08-14')!.map((t) => t.id)).toEqual(['b'])
  })

  test('nothing in, nothing out', () => {
    expect(groupTilesByDay([]).size).toBe(0)
  })
})
