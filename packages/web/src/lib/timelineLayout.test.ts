import { describe, expect, test } from 'bun:test'
import type { TimelineBucket, TimelineTile } from '@imogen/shared'
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

const tile = (id: string, capturedAt: string, width = 4032, height = 3024): TimelineTile => ({
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
    const measured = new Map([['2011-08-14', 517]])
    const table = buildSegments([bucket('2011-08-14', 12)], new Map(), OPTIONS, measured)
    expect(table.byDate.get('2011-08-14')!.height).toBe(517)
    expect(table.byDate.get('2011-08-14')!.measured).toBe(true)
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
  test('is zero when what changed is below the viewport', () => {
    const buckets = [bucket('2011-08-15', 10), bucket('2011-08-14', 10)]
    const before = buildSegments(buckets, new Map(), OPTIONS, new Map())
    const after = buildSegments(buckets, new Map(), OPTIONS, new Map([['2011-08-14', 900]]))
    expect(scrollDelta(before, after, 0)).toBe(0)
  })

  test('is the accumulated change when it happened above the viewport', () => {
    const buckets = [bucket('2011-08-15', 10), bucket('2011-08-14', 10)]
    const before = buildSegments(buckets, new Map(), OPTIONS, new Map())
    const grew = 900 - before.byDate.get('2011-08-15')!.height
    const after = buildSegments(buckets, new Map(), OPTIONS, new Map([['2011-08-15', 900]]))
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
})

describe('scrollDelta keeps the same photograph under the reader', () => {
  const buckets = [bucket('2011-08-15', 10), bucket('2011-08-14', 10), bucket('2011-08-13', 10)]

  // The invariant the whole thing exists for: whatever the day being read moves by, the
  // scroll position must move by the same amount and in the same direction. An inverted
  // sign fails this even though its magnitude is right.
  const shiftOfTheDayBeingRead = (height: number) => {
    const before = buildSegments(buckets, new Map(), OPTIONS, new Map())
    const scrollTop = before.byDate.get('2011-08-13')!.top + 10
    const after = buildSegments(buckets, new Map(), OPTIONS, new Map([['2011-08-15', height]]))
    const moved = after.byDate.get('2011-08-13')!.top - before.byDate.get('2011-08-13')!.top
    return { moved, delta: scrollDelta(before, after, scrollTop) }
  }

  test('a day above growing pushes the reader down by exactly as much', () => {
    const { moved, delta } = shiftOfTheDayBeingRead(900)
    expect(moved).toBeGreaterThan(0)
    expect(delta).toBe(moved)
  })

  test('a day above shrinking pulls the reader up, not down', () => {
    const { moved, delta } = shiftOfTheDayBeingRead(120)
    expect(moved).toBeLessThan(0)
    expect(delta).toBe(moved)
  })

  test('a day trashed above the viewport gives its height back', () => {
    const before = buildSegments(buckets, new Map(), OPTIONS, new Map())
    const after = buildSegments(buckets.slice(1), new Map(), OPTIONS, new Map())
    expect(scrollDelta(before, after, 5000)).toBe(-before.byDate.get('2011-08-15')!.height)
  })

  test('two identical tables ask for no compensation at all', () => {
    const before = buildSegments(buckets, new Map(), OPTIONS, new Map())
    const after = buildSegments(buckets, new Map(), OPTIONS, new Map())
    expect(scrollDelta(before, after, 5000)).toBe(0)
  })
})

describe('measuring a day', () => {
  test('a day fetched only in part stays an estimate rather than measuring short', () => {
    const loaded = new Map([['2011-08-14', [tile('a', '2011-08-14T09:00:00.000Z')]]])
    const table = buildSegments([bucket('2011-08-14', 60)], loaded, OPTIONS, new Map())
    expect(table.byDate.get('2011-08-14')!.measured).toBe(false)
    expect(table.byDate.get('2011-08-14')!.height).toBe(estimateDayHeight(60, OPTIONS))
  })

  test('a height learned from tiles is kept, so evicting them does not move the day', () => {
    const tiles = Array.from({ length: 12 }, (_, i) => tile(`p${i}`, '2011-08-14T09:00:00.000Z'))
    const measured = new Map<string, number>()
    const withTiles = buildSegments(
      [bucket('2011-08-14', 12)],
      new Map([['2011-08-14', tiles]]),
      OPTIONS,
      measured,
    )
    const afterEviction = buildSegments([bucket('2011-08-14', 12)], new Map(), OPTIONS, measured)
    expect(afterEviction.byDate.get('2011-08-14')!.height).toBe(
      withTiles.byDate.get('2011-08-14')!.height,
    )
    expect(afterEviction.byDate.get('2011-08-14')!.measured).toBe(true)
  })

  test('a remembered height wins over the tiles currently in hand', () => {
    const loaded = new Map([['2011-08-14', [tile('a', '2011-08-14T09:00:00.000Z')]]])
    const table = buildSegments(
      [bucket('2011-08-14', 1)],
      loaded,
      OPTIONS,
      new Map([['2011-08-14', 517]]),
    )
    expect(table.byDate.get('2011-08-14')!.height).toBe(517)
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

describe('groupTilesByDay', () => {
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
