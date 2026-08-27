import { describe, expect, test } from 'bun:test'
import { rollUpPeriods } from './timelinePeriods.ts'

const bucket = (date: string, count: number, coverAssetId: string | null = null) => ({
  date,
  count,
  coverAssetId,
})

describe('rollUpPeriods', () => {
  test('sums a year and keeps its newest day as where the timeline shows it', () => {
    const cards = rollUpPeriods(
      [bucket('2012-11-03', 4), bucket('2012-06-01', 10), bucket('2011-08-14', 2)],
      'year',
    )
    expect(cards.map((card) => card.key)).toEqual(['2012', '2011'])
    expect(cards[0]!.count).toBe(14)
    expect(cards[0]!.topDate).toBe('2012-11-03')
  })

  test('rolls months up under one year, newest first', () => {
    const cards = rollUpPeriods(
      [bucket('2012-11-03', 4), bucket('2012-11-01', 1), bucket('2012-06-01', 10)],
      'month',
    )
    expect(cards.map((card) => card.key)).toEqual(['2012-11', '2012-06'])
    expect(cards[0]!.count).toBe(5)
    expect(cards[0]!.topDate).toBe('2012-11-03')
  })

  /*
   * The point of `coverAssetId` being nullable. Days arrive newest first, so the first
   * cover a period offers is the newest ready photograph in it — and during an import the
   * newest days are precisely the ones still being processed, so stepping past nulls is
   * the common path rather than the edge case.
   */
  test('takes the newest cover the period actually has', () => {
    const cards = rollUpPeriods(
      [bucket('2012-11-03', 4), bucket('2012-11-01', 1, 'ready-one'), bucket('2012-10-02', 3)],
      'year',
    )
    expect(cards[0]!.coverAssetId).toBe('ready-one')
  })

  test('a period with nothing ready yet reports no cover rather than vanishing', () => {
    const cards = rollUpPeriods([bucket('2026-08-27', 90), bucket('2026-08-26', 10)], 'month')
    expect(cards).toHaveLength(1)
    expect(cards[0]!.coverAssetId).toBeNull()
    expect(cards[0]!.count).toBe(100)
  })

  /** The overview draws from the segment table until the covers spine lands. */
  test('buckets that carry no cover field at all roll up as coverless', () => {
    const cards = rollUpPeriods([{ date: '2011-08-14', count: 2 }], 'year')
    expect(cards[0]!.coverAssetId).toBeNull()
  })

  test('no buckets is no cards, not a throw', () => {
    expect(rollUpPeriods([], 'year')).toEqual([])
  })
})
