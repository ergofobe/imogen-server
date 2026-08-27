import { describe, expect, test } from 'bun:test'
import { gridTopFrom, scrollTargetFor } from './scroller.ts'

/**
 * The single account of how grid coordinates and scroller coordinates relate. `PhotoGrid`,
 * the rail and the overview all read and write the scroll position through it, so an error
 * here is an error in three places at once — and one that only shows at the ends, where a
 * silent browser clamp would hide it.
 */
describe('scrollTargetFor', () => {
  const page = { scrollHeight: 10_000, clientHeight: 900 }

  test('adds the grid offset, so page furniture above the grid is accounted for', () => {
    expect(scrollTargetFor(page, 120, 500)).toBe(620)
  })

  test('a grid flush with the top of the scroller needs no adjustment', () => {
    expect(scrollTargetFor(page, 0, 500)).toBe(500)
  })

  test('clamps at the top rather than asking for a negative scroll position', () => {
    expect(scrollTargetFor(page, 120, -5000)).toBe(0)
  })

  /*
   * The end that matters. A browser silently clamps an out-of-range assignment, so without
   * this the rail would write one position, read back another, and jitter against its own
   * thumb for the rest of a drag held at the bottom.
   */
  test('clamps at the bottom to the last scrollable pixel', () => {
    expect(scrollTargetFor(page, 120, 99_999)).toBe(9100)
  })

  test('a scroller shorter than its viewport cannot be scrolled at all', () => {
    expect(scrollTargetFor({ scrollHeight: 400, clientHeight: 900 }, 0, 5000)).toBe(0)
  })
})

describe('gridTopFrom', () => {
  test('is the inverse of scrollTargetFor wherever no clamp applies', () => {
    const page = { scrollHeight: 10_000, clientHeight: 900 }
    for (const gridTop of [0, 1, 500, 8000]) {
      expect(gridTopFrom(scrollTargetFor(page, 120, gridTop), 120)).toBe(gridTop)
    }
  })

  test('reports a reader above the grid as a negative grid position, unclamped', () => {
    // Scrolled to the very top with a header above the grid: the reader is genuinely
    // before the grid begins, and rounding that to zero would claim they are on day one.
    expect(gridTopFrom(0, 120)).toBe(-120)
  })
})
