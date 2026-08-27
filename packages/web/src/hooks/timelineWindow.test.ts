import { describe, expect, test } from 'bun:test'
import type { TimelineBucket, TimelineTile } from '@imogen/shared'
import { buildSegments, type LayoutOptions } from '../lib/timelineLayout.ts'
import {
  anchoredScrollTop,
  evictPeriods,
  MAX_LOADED_PERIODS,
  mergeDays,
  neighbouringPeriod,
  periodsToFetch,
  tilesInTimelineOrder,
} from './timelineWindow.ts'

describe('periodsToFetch', () => {
  test('asks for the visible period and one either side', () => {
    expect(periodsToFetch(['2011-08'], ['2011-09', '2011-08', '2011-07', '2011-06'])).toEqual([
      '2011-09',
      '2011-08',
      '2011-07',
    ])
  })

  test('does not fall off the ends of the library', () => {
    expect(periodsToFetch(['2011-09'], ['2011-09', '2011-08'])).toEqual(['2011-09', '2011-08'])
  })

  test('a drag spanning years still asks only for what it touches', () => {
    const all = ['2011-09', '2011-08', '2011-07']
    expect(periodsToFetch([], all)).toEqual([])
  })

  test('a period the spine has never heard of asks for nothing', () => {
    expect(periodsToFetch(['1999-01'], ['2011-09', '2011-08'])).toEqual([])
  })

  test('several visible periods are asked for once each, in timeline order', () => {
    const all = ['2011-09', '2011-08', '2011-07', '2011-06', '2011-05']
    expect(periodsToFetch(['2011-08', '2011-07'], all)).toEqual([
      '2011-09',
      '2011-08',
      '2011-07',
      '2011-06',
    ])
  })
})

describe('evictPeriods', () => {
  const usedPeriods = Array.from(
    { length: MAX_LOADED_PERIODS + 3 },
    (_, i) => `2011-${String(i + 1).padStart(2, '0')}`,
  )

  test('keeps the most recently used and drops the rest', () => {
    const kept = evictPeriods(usedPeriods, usedPeriods.slice(-2))
    expect(kept).toHaveLength(MAX_LOADED_PERIODS)
    expect(kept).toContain(usedPeriods.at(-1)!)
    expect(kept).toContain(usedPeriods.at(-2)!)
  })

  test('never evicts a period that is currently on screen', () => {
    expect(evictPeriods(usedPeriods, [usedPeriods[0]!])).toContain(usedPeriods[0]!)
  })

  // A drag across a year can put more months on screen than the budget allows. Throwing
  // away a month the reader is looking at to honour a cap would blank the very rows they
  // are staring at, so the cap yields instead.
  test('a screen holding more periods than the budget keeps all of them', () => {
    const kept = evictPeriods(usedPeriods, usedPeriods)
    expect(kept).toEqual(usedPeriods)
  })

  test('nothing loaded evicts nothing', () => {
    expect(evictPeriods([], [])).toEqual([])
  })
})

describe('mergeDays', () => {
  const tile = (id: string, capturedAt: string): TimelineTile => ({
    id,
    capturedAt,
    width: 4032,
    height: 3024,
    type: 'image',
    status: 'ready',
    favorite: false,
    duration: null,
    placeholderColor: null,
    livePhotoVideoId: null,
  })

  // The bucket endpoint pages at 5000. A wedding shot across a page boundary only ever
  // reaches its bucket count if the second page adds to the first rather than replacing
  // it — otherwise the day sits on an estimate for as long as it is loaded.
  test('a day split across two pages ends up whole', () => {
    const first = [tile('a', '2011-08-14T09:00:00.000Z')]
    const second = [tile('b', '2011-08-14T10:00:00.000Z')]
    const merged = mergeDays(new Map(), '2011-08', [...first, ...second])
    expect(merged.get('2011-08-14')!.map((t) => t.id)).toEqual(['a', 'b'])
  })

  test('reloading a period replaces its own days rather than doubling them', () => {
    const once = mergeDays(new Map(), '2011-08', [
      tile('a', '2011-08-14T09:00:00.000Z'),
      tile('b', '2011-08-14T10:00:00.000Z'),
    ])
    // The reader trashed one; the period is fetched again and comes back one shorter.
    const again = mergeDays(once, '2011-08', [tile('a', '2011-08-14T09:00:00.000Z')])
    expect(again.get('2011-08-14')!.map((t) => t.id)).toEqual(['a'])
  })

  test('a day emptied by a reload leaves no stale entry behind', () => {
    const once = mergeDays(new Map(), '2011-08', [tile('a', '2011-08-14T09:00:00.000Z')])
    expect(mergeDays(once, '2011-08', []).has('2011-08-14')).toBe(false)
  })

  test('the days of another period are left alone', () => {
    const august = mergeDays(new Map(), '2011-08', [tile('a', '2011-08-14T09:00:00.000Z')])
    const both = mergeDays(august, '2011-09', [tile('b', '2011-09-02T09:00:00.000Z')])
    expect([...both.keys()].sort()).toEqual(['2011-08-14', '2011-09-02'])
  })
})

const OPTIONS: LayoutOptions = {
  width: 1200,
  targetHeight: 208,
  gap: 4,
  sectionGap: 44,
  headerHeight: 42,
}

const bucket = (date: string, count: number): TimelineBucket => ({
  date,
  count,
  coverAssetId: null,
})

/** A day of panoramas measures far taller than an average-aspect estimate. */
const panoramas = (date: string, count: number): TimelineTile[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `${date}-${i}`,
    capturedAt: `${date}T09:00:00.000Z`,
    width: 6000,
    height: 1000,
    type: 'image' as const,
    status: 'ready' as const,
    favorite: false,
    duration: null,
    placeholderColor: null,
    livePhotoVideoId: null,
  }))

describe('anchoredScrollTop', () => {
  const days = [bucket('2011-08-15', 40), bucket('2011-08-14', 40), bucket('2011-08-13', 40)]
  const estimated = buildSegments(days, new Map(), OPTIONS, new Map())
  const resolved = buildSegments(
    days,
    new Map([['2011-08-15', panoramas('2011-08-15', 40)]]),
    OPTIONS,
    new Map(),
  )

  /** The page furniture above the grid: a title, and the shell's own padding. */
  const GRID_OFFSET = 120
  const VIEWPORT = 900

  /** Where a photograph sits on the reader's screen, in viewport pixels. */
  const onScreen = (table: typeof estimated, date: string, scrollTop: number) =>
    GRID_OFFSET + table.byDate.get(date)!.top - scrollTop

  const scroller = (scrollTop: number, table: typeof estimated) => ({
    scrollTop,
    scrollHeight: GRID_OFFSET + table.totalHeight,
    clientHeight: VIEWPORT,
  })

  test('the photograph under the reader does not move when a day above resolves', () => {
    const before = GRID_OFFSET + estimated.byDate.get('2011-08-13')!.top - 300
    const after = anchoredScrollTop(estimated, resolved, scroller(before, resolved), GRID_OFFSET)
    expect(onScreen(resolved, '2011-08-13', after)).toBeCloseTo(
      onScreen(estimated, '2011-08-13', before),
      6,
    )
  })

  test('a day resolving below the reader asks for no movement at all', () => {
    const below = buildSegments(
      days,
      new Map([['2011-08-13', panoramas('2011-08-13', 40)]]),
      OPTIONS,
      new Map(),
    )
    expect(anchoredScrollTop(estimated, below, scroller(0, below), GRID_OFFSET)).toBe(0)
  })

  // The browser clamps an out-of-range assignment silently, so a compensation that lands
  // outside the scrollable range half-applies with nothing to show for it. Clamping here
  // makes the ceiling explicit.
  test('never asks for a position above the top of the page', () => {
    const shrunk = buildSegments([bucket('2011-08-13', 40)], new Map(), OPTIONS, new Map())
    const at = anchoredScrollTop(estimated, shrunk, scroller(10, shrunk), GRID_OFFSET)
    expect(at).toBe(0)
  })

  test('never asks for a position past the end of the content', () => {
    const grown = buildSegments(
      days,
      new Map([['2011-08-13', panoramas('2011-08-13', 40)]]),
      OPTIONS,
      new Map(),
    )
    const bottom = GRID_OFFSET + estimated.totalHeight - VIEWPORT
    const at = anchoredScrollTop(estimated, grown, scroller(bottom, estimated), GRID_OFFSET)
    expect(at).toBeLessThanOrEqual(GRID_OFFSET + estimated.totalHeight - VIEWPORT)
    expect(at).toBeGreaterThanOrEqual(0)
  })

  test('two identical tables leave the scroll position exactly where it was', () => {
    expect(anchoredScrollTop(estimated, estimated, scroller(4321, estimated), GRID_OFFSET)).toBe(
      4321,
    )
  })

  /**
   * The real sequence, not a single swap: a month lands, then the next, then the one after,
   * each replacing an estimate with a measurement while the reader sits still two hundred
   * pixels into a day of their own. Every one of those days is above them and moves them.
   * Applying the compensation after each, the day they are reading has to stay in exactly
   * the same place on their screen the whole way through — a sign error, a dropped step, or
   * a compensation that composes wrongly all show up here even when one swap looks right.
   */
  test('a run of days resolving one after another never moves the reader', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      bucket(`2011-08-${String(28 - i).padStart(2, '0')}`, 25),
    )
    const READING = '2011-08-17'

    let table = buildSegments(many, new Map(), OPTIONS, new Map())
    // Inside the day, not above it: a day the reader is only part way through keeps their
    // share of it rather than its top edge, which is the module's documented behaviour.
    let scrollTop = GRID_OFFSET + table.byDate.get(READING)!.top + 200
    const settled = GRID_OFFSET + table.byDate.get(READING)!.top - scrollTop

    const arrived = new Map<string, TimelineTile[]>()
    for (const day of ['2011-08-28', '2011-08-24', '2011-08-19', '2011-08-18']) {
      arrived.set(day, panoramas(day, 25))
      const next = buildSegments(many, arrived, OPTIONS, new Map())
      scrollTop = anchoredScrollTop(
        table,
        next,
        {
          scrollTop,
          scrollHeight: GRID_OFFSET + next.totalHeight,
          clientHeight: VIEWPORT,
        },
        GRID_OFFSET,
      )
      table = next
      expect(GRID_OFFSET + table.byDate.get(READING)!.top - scrollTop).toBeCloseTo(settled, 6)
    }
  })
})

describe('tilesInTimelineOrder', () => {
  const tile = (id: string, capturedAt: string): TimelineTile => ({
    id,
    capturedAt,
    width: 4032,
    height: 3024,
    type: 'image',
    status: 'ready',
    favorite: false,
    duration: null,
    placeholderColor: null,
    livePhotoVideoId: null,
  })

  const table = buildSegments(
    [bucket('2011-09-02', 1), bucket('2011-08-14', 2), bucket('2011-07-30', 1)],
    new Map(),
    OPTIONS,
    new Map(),
  )

  // Months arrive in whatever order the reader wanders through them. Walking the spine
  // rather than the fetch log is what makes the viewer's arrows follow the timeline.
  test('reads the days off the spine, not off the order the months arrived in', () => {
    const tiles = new Map([
      ['2011-07-30', [tile('c', '2011-07-30T09:00:00.000Z')]],
      ['2011-09-02', [tile('a', '2011-09-02T09:00:00.000Z')]],
      ['2011-08-14', [tile('b1', '2011-08-14T09:00:00.000Z'), tile('b2', '2011-08-14T10:00:00Z')]],
    ])
    expect(tilesInTimelineOrder(table, tiles).map((t) => t.id)).toEqual(['a', 'b1', 'b2', 'c'])
  })

  test('days that are not loaded are simply not there', () => {
    const tiles = new Map([['2011-08-14', [tile('b1', '2011-08-14T09:00:00.000Z')]]])
    expect(tilesInTimelineOrder(table, tiles).map((t) => t.id)).toEqual(['b1'])
  })

  test('nothing loaded is an empty walk rather than a throw', () => {
    expect(tilesInTimelineOrder(table, new Map())).toEqual([])
  })

  describe('neighbouringPeriod', () => {
    test('finds the month the next photograph along belongs to', () => {
      expect(neighbouringPeriod(table, '2011-08-14', 1)).toBe('2011-07')
      expect(neighbouringPeriod(table, '2011-08-14', -1)).toBe('2011-09')
    })

    test('the ends of the library have nothing beyond them', () => {
      expect(neighbouringPeriod(table, '2011-09-02', -1)).toBeNull()
      expect(neighbouringPeriod(table, '2011-07-30', 1)).toBeNull()
    })

    test('a day the spine does not know reports nothing', () => {
      expect(neighbouringPeriod(table, '1999-01-01', 1)).toBeNull()
    })
  })
})
