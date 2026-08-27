import { describe, expect, test } from 'bun:test'
import { buildSegments } from '../lib/timelineLayout.ts'
import { dayNumber, railTicks, stepMonth } from './TimelineRail.tsx'

const OPTIONS = { width: 1200, targetHeight: 208, gap: 4, sectionGap: 44, headerHeight: 40 }
const bucket = (date: string, count: number) => ({ date, count, coverAssetId: null })

/** Only labels compete for room. A bare mark costs no space and never collides. */
const labelledYs = (ticks: ReturnType<typeof railTicks>) =>
  ticks
    .filter((t) => t.labelled)
    .map((t) => t.y)
    .sort((a, b) => a - b)

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
    const ys = labelledYs(ticks)
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
    const ys = labelledYs(railTicks(table, 800))
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
    const ys = labelledYs(ticks)
    for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(12)
    expect(ticks.some((t) => t.label === '2014' && t.labelled)).toBe(true)
    expect(ticks.filter((t) => t.kind === 'year' && t.labelled).length).toBeLessThan(5)

    /*
     * But every year is still MARKED. Dropping the tick outright would have the rail say
     * there are no photographs in the years it had no room to name — a reader seeing
     * `2014 · 2012 · 2009` reasonably concludes 2013 is empty. A bare boundary costs no
     * label space and tells no such lie.
     */
    for (const year of ['2014', '2013', '2012', '2011', '2010']) {
      expect(ticks.some((t) => t.kind === 'year' && t.label === year)).toBe(true)
    }
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
    expect(ticks.some((t) => t.kind === 'year' && t.label === '2011' && t.labelled)).toBe(true)
    const ys = labelledYs(ticks)
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
    expect(years.some((t) => t.label === '2019' && t.labelled)).toBe(true)
    expect(years.some((t) => t.label === '2020' && t.labelled)).toBe(false)
    // Demoted, not discarded: 2020's boundary is still drawn.
    expect(years.some((t) => t.label === '2020')).toBe(true)
  })
})

describe('stepMonth', () => {
  /*
   * The table is sorted, so the next month is the next month that EXISTS — found by
   * walking the days, not by counting calendar months and hoping one of them is
   * occupied. A twenty-year library has gaps of years in it: a camera that broke, a
   * stretch before digital, a period nobody photographed.
   */
  const gapped = () =>
    buildSegments(
      [
        bucket('2026-08-20', 40),
        bucket('2026-08-02', 10),
        bucket('2026-05-11', 25),
        // Nothing at all between May 2026 and March 2019 — over seven years.
        bucket('2019-03-30', 15),
        bucket('2019-03-04', 5),
        bucket('2011-07-19', 8),
      ],
      new Map(),
      OPTIONS,
      new Map(),
    )

  const topOf = (table: ReturnType<typeof buildSegments>, date: string) =>
    table.byDate.get(date)!.top

  test('steps to the next older month that exists, across a seven-year gap', () => {
    const table = gapped()
    expect(stepMonth(table, topOf(table, '2026-05-11'), -1)).toBe(topOf(table, '2019-03-30'))
  })

  test('steps to the next newer month that exists, across the same gap', () => {
    const table = gapped()
    expect(stepMonth(table, topOf(table, '2019-03-30'), 1)).toBe(topOf(table, '2026-05-11'))
  })

  test('lands on a month top from the middle of a month, in both directions', () => {
    const table = gapped()
    const insideAugust = topOf(table, '2026-08-02')
    expect(stepMonth(table, insideAugust, -1)).toBe(topOf(table, '2026-05-11'))
    // The oldest day of March 2019 steps up to the top of March, not past it.
    expect(stepMonth(table, topOf(table, '2019-03-04'), 1)).toBe(topOf(table, '2026-05-11'))
  })

  test('stepping newer from anywhere in the newest month lands at the top of the library', () => {
    const table = gapped()
    expect(stepMonth(table, topOf(table, '2026-08-02'), 1)).toBe(0)
  })

  test('stepping older from the oldest month stays put rather than leaping', () => {
    const table = gapped()
    const oldest = topOf(table, '2011-07-19')
    expect(stepMonth(table, oldest, -1)).toBe(oldest)
  })

  test('an empty table does not throw', () => {
    const empty = buildSegments([], new Map(), OPTIONS, new Map())
    expect(stepMonth(empty, 0, -1)).toBe(0)
    expect(stepMonth(empty, 0, 1)).toBe(0)
  })
})

describe('dayNumber', () => {
  test('counts whole UTC days, so the slider value rises with newness', () => {
    expect(dayNumber('1970-01-01')).toBe(0)
    expect(dayNumber('1970-01-02')).toBe(1)
    expect(dayNumber('2012-06-01') - dayNumber('2012-05-01')).toBe(31)
    expect(dayNumber('2026-08-27')).toBeGreaterThan(dayNumber('2011-08-14'))
  })
})
