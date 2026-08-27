import { describe, expect, test } from 'bun:test'
import { buildSegments } from '../lib/timelineLayout.ts'
import { railTicks } from './TimelineRail.tsx'

const OPTIONS = { width: 1200, targetHeight: 208, gap: 4, sectionGap: 44, headerHeight: 40 }
const bucket = (date: string, count: number) => ({ date, count, coverAssetId: null })

describe('railTicks', () => {
  test('marks each year once, in order, inside the rail', () => {
    const table = buildSegments(
      [bucket('2013-01-01', 50), bucket('2012-06-01', 50), bucket('2011-08-14', 50)],
      new Map(),
      OPTIONS,
      new Map(),
    )
    const years = railTicks(table, 800).filter((t) => t.kind === 'year')
    expect(years.map((t) => t.label)).toEqual(['2013', '2012', '2011'])
    for (const tick of years) {
      expect(tick.y).toBeGreaterThanOrEqual(0)
      expect(tick.y).toBeLessThanOrEqual(800)
    }
  })

  test('a dense year takes more rail than a thin one', () => {
    const table = buildSegments(
      [
        ...Array.from({ length: 30 }, (_, i) =>
          bucket(`2012-06-${String(i + 1).padStart(2, '0')}`, 300),
        ),
        bucket('2011-08-14', 2),
      ],
      new Map(),
      OPTIONS,
      new Map(),
    )
    const [dense, thin] = railTicks(table, 800).filter((t) => t.kind === 'year')
    expect(thin!.y - dense!.y).toBeGreaterThan(400)
  })

  test('an empty table produces no ticks rather than throwing', () => {
    expect(railTicks(buildSegments([], new Map(), OPTIONS, new Map()), 800)).toEqual([])
  })

  test('a rail with no height on screen produces no ticks rather than dividing by it', () => {
    const table = buildSegments([bucket('2012-06-01', 50)], new Map(), OPTIONS, new Map())
    expect(railTicks(table, 0)).toEqual([])
  })

  /*
   * The two rules that keep the rail legible. A year is only subdivided once it owns
   * enough rail to be worth subdividing, and no two ticks are allowed to land on top of
   * one another however lopsided a year's months are.
   */
  test('a year too short to subdivide gets a year tick and nothing else', () => {
    const table = buildSegments(
      [
        ...Array.from({ length: 12 }, (_, i) =>
          bucket(`2012-${String(12 - i).padStart(2, '0')}-01`, 2000),
        ),
        ...Array.from({ length: 12 }, (_, i) =>
          bucket(`2011-${String(12 - i).padStart(2, '0')}-01`, 1),
        ),
      ],
      new Map(),
      OPTIONS,
      new Map(),
    )
    const ticks = railTicks(table, 800)
    expect(ticks.filter((t) => t.kind === 'year').map((t) => t.label)).toEqual(['2012', '2011'])
    expect(ticks.some((t) => t.kind === 'month' && t.label.startsWith('2012'))).toBe(true)
    expect(ticks.some((t) => t.kind === 'month' && t.label.startsWith('2011'))).toBe(false)
  })

  test('months are labelled newest first within their year and never collide', () => {
    const table = buildSegments(
      Array.from({ length: 12 }, (_, i) =>
        bucket(`2012-${String(12 - i).padStart(2, '0')}-01`, 90),
      ),
      new Map(),
      OPTIONS,
      new Map(),
    )
    const ticks = railTicks(table, 800)
    const months = ticks.filter((t) => t.kind === 'month')
    // The year tick already stands at the newest month, so December is not repeated.
    expect(months.map((t) => t.label)).toEqual([
      '2012-11',
      '2012-10',
      '2012-09',
      '2012-08',
      '2012-07',
      '2012-06',
      '2012-05',
      '2012-04',
      '2012-03',
      '2012-02',
      '2012-01',
    ])
    const ys = ticks.map((t) => t.y).sort((a, b) => a - b)
    for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(12)
  })

  test('one enormous month does not stack its siblings on a single pixel', () => {
    const table = buildSegments(
      [
        bucket('2012-12-01', 20_000),
        ...Array.from({ length: 11 }, (_, i) =>
          bucket(`2012-${String(11 - i).padStart(2, '0')}-01`, 1),
        ),
      ],
      new Map(),
      OPTIONS,
      new Map(),
    )
    const ys = railTicks(table, 800)
      .map((t) => t.y)
      .sort((a, b) => a - b)
    for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(12)
  })
  /*
   * Found by looking at the thing rather than at the test. A twenty-year library has thin
   * years in it — a year of two hundred frames next to a year of nine thousand owns six
   * pixels of rail — and three year labels printed on top of one another is worse than
   * one label and a drag that says the date out loud.
   */
  test('years too thin to label do not overprint their neighbours', () => {
    const table = buildSegments(
      [
        bucket('2014-06-01', 12_000),
        bucket('2013-06-01', 3),
        bucket('2012-06-01', 3),
        bucket('2011-06-01', 3),
        bucket('2010-06-01', 3),
      ],
      new Map(),
      OPTIONS,
      new Map(),
    )
    const ticks = railTicks(table, 800)
    const ys = ticks.map((t) => t.y).sort((a, b) => a - b)
    for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(12)
    // The dense year is always marked; the huddle below it keeps whichever it has room for.
    expect(ticks.some((t) => t.label === '2014')).toBe(true)
    expect(ticks.filter((t) => t.kind === 'year').length).toBeLessThan(5)
  })

  test('a year tick takes precedence over a month tick it lands on', () => {
    const table = buildSegments(
      [
        // A year whose months are spread enough to be marked, then a new year immediately
        // under its last month tick.
        ...Array.from({ length: 12 }, (_, i) =>
          bucket(`2012-${String(12 - i).padStart(2, '0')}-01`, 900),
        ),
        bucket('2011-12-31', 4),
      ],
      new Map(),
      OPTIONS,
      new Map(),
    )
    const ticks = railTicks(table, 800)
    expect(ticks.some((t) => t.kind === 'year' && t.label === '2011')).toBe(true)
    const ys = ticks.map((t) => t.y).sort((a, b) => a - b)
    for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(12)
  })

  /*
   * Which of two colliding years keeps the label. Seen on real data: a lockdown year of
   * two hundred frames sat six pixels above a year of four thousand and took the label
   * off it, so the rail named the year with nothing in it and left the one worth finding
   * blank. The bigger claim on the rail wins.
   */
  test('the denser of two colliding years keeps the label', () => {
    const table = buildSegments(
      [
        bucket('2021-06-01', 30),
        bucket('2020-12-01', 40),
        ...Array.from({ length: 20 }, (_, i) =>
          bucket(`2019-06-${String(i + 1).padStart(2, '0')}`, 400),
        ),
      ],
      new Map(),
      OPTIONS,
      new Map(),
    )
    const years = railTicks(table, 800).filter((t) => t.kind === 'year')
    expect(years.some((t) => t.label === '2019')).toBe(true)
    expect(years.some((t) => t.label === '2020')).toBe(false)
  })
})
