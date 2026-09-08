import { describe, expect, test } from 'bun:test'
import { type Corners, corners, iou, matchBoxes, storedBox } from './overlap.ts'

describe('iou', () => {
  test('identical boxes overlap completely', () => {
    const box: Corners = [10, 10, 30, 30]
    expect(iou(box, box)).toBe(1)
  })

  test('disjoint boxes do not overlap at all', () => {
    expect(iou([0, 0, 10, 10], [100, 100, 110, 110])).toBe(0)
  })

  /**
   * Two 10x10 boxes offset by 5 on each axis share a 5x5 corner: overlap 25, union
   * 100 + 100 - 25 = 175, so the ratio is 25/175 = 1/7.
   */
  test('a known partial overlap matches the hand-computed ratio', () => {
    expect(iou([0, 0, 10, 10], [5, 5, 15, 15])).toBeCloseTo(1 / 7, 10)
  })

  test('a stored box converts to the corners the detector emits', () => {
    expect(corners({ x: 5, y: 10, width: 20, height: 30 })).toEqual([5, 10, 25, 40])
  })

  test('the detector’s corners round to the whole pixels the table stores', () => {
    expect(storedBox([5.4, 10.6, 25.5, 40.2])).toEqual({ x: 5, y: 11, width: 20, height: 30 })
  })
})

describe('matchBoxes', () => {
  test('pairs a confirmed box with the detection it overlaps best', () => {
    const confirmed = [{ x: 0, y: 0, width: 10, height: 10 }]
    const detected = [{ box: [0, 0, 10, 10] as Corners }, { box: [200, 200, 210, 210] as Corners }]

    const { pairs, unmatched } = matchBoxes(confirmed, detected)

    expect(pairs).toHaveLength(1)
    expect(pairs[0]!.confirmed).toBe(confirmed[0]!)
    expect(pairs[0]!.detection).toBe(detected[0]!)
    expect(unmatched).toEqual([detected[1]!])
  })

  test('honours the threshold: an overlap below it is left unmatched', () => {
    const confirmed = [{ x: 0, y: 0, width: 10, height: 10 }]
    // Overlap of 1 against a union of 199 — iou ≈ 0.005, far under the default 0.5.
    const detected = [{ box: [9, 9, 19, 19] as Corners }]

    const { pairs, unmatched } = matchBoxes(confirmed, detected)

    expect(pairs).toBeEmpty()
    expect(unmatched).toEqual(detected)
  })

  test('each side is used at most once', () => {
    // Two confirmed boxes both overlap the one detection; only the better match takes it.
    const confirmed = [
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 2, y: 2, width: 10, height: 10 },
    ]
    const detected = [{ box: [0, 0, 10, 10] as Corners }]

    const { pairs, unmatched, orphaned } = matchBoxes(confirmed, detected)

    expect(pairs).toHaveLength(1)
    expect(pairs[0]!.confirmed).toBe(confirmed[0]!)
    expect(unmatched).toBeEmpty()
    expect(orphaned).toEqual([confirmed[1]!])
  })

  test('leftover detections come back unmatched', () => {
    const confirmed: Array<{ x: number; y: number; width: number; height: number }> = []
    const detected = [{ box: [0, 0, 10, 10] as Corners }]

    const { pairs, unmatched } = matchBoxes(confirmed, detected)

    expect(pairs).toBeEmpty()
    expect(unmatched).toEqual(detected)
  })

  test('a confirmed face nothing was detected near comes back orphaned', () => {
    const confirmed = [{ x: 0, y: 0, width: 10, height: 10 }]
    const detected = [{ box: [200, 200, 210, 210] as Corners }]

    const { pairs, unmatched, orphaned } = matchBoxes(confirmed, detected)

    expect(pairs).toBeEmpty()
    expect(unmatched).toEqual(detected)
    expect(orphaned).toEqual(confirmed)
  })
})
