import { describe, expect, test } from 'bun:test'
import { iou, matchBoxes } from './overlap.ts'

describe('iou', () => {
  test('identical boxes overlap completely', () => {
    const box = { x: 10, y: 10, width: 20, height: 20 }
    expect(iou(box, box)).toBe(1)
  })

  test('disjoint boxes do not overlap at all', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 }
    const b = { x: 100, y: 100, width: 10, height: 10 }
    expect(iou(a, b)).toBe(0)
  })

  /**
   * Two 10x10 boxes offset by 5 on each axis share a 5x5 corner: overlap 25, union
   * 100 + 100 - 25 = 175, so the ratio is 25/175 = 1/7.
   */
  test('a known partial overlap matches the hand-computed ratio', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 }
    const b = { x: 5, y: 5, width: 10, height: 10 }
    expect(iou(a, b)).toBeCloseTo(1 / 7, 10)
  })
})

describe('matchBoxes', () => {
  test('pairs a confirmed box with the detection it overlaps best', () => {
    const confirmed = [{ x: 0, y: 0, width: 10, height: 10 }]
    const detected = [
      { box: [0, 0, 10, 10] as [number, number, number, number] },
      { box: [200, 200, 210, 210] as [number, number, number, number] },
    ]

    const { pairs, unmatched } = matchBoxes(confirmed, detected)

    expect(pairs).toHaveLength(1)
    expect(pairs[0]!.confirmed).toBe(confirmed[0]!)
    expect(pairs[0]!.detection).toBe(detected[0]!)
    expect(unmatched).toEqual([detected[1]!])
  })

  test('honours the threshold: an overlap below it is left unmatched', () => {
    const confirmed = [{ x: 0, y: 0, width: 10, height: 10 }]
    // Overlap of 1 against a union of 199 — iou ≈ 0.005, far under the default 0.5.
    const detected = [{ box: [9, 9, 19, 19] as [number, number, number, number] }]

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
    const detected = [{ box: [0, 0, 10, 10] as [number, number, number, number] }]

    const { pairs, unmatched } = matchBoxes(confirmed, detected)

    expect(pairs).toHaveLength(1)
    expect(pairs[0]!.confirmed).toBe(confirmed[0]!)
    expect(unmatched).toBeEmpty()
  })

  test('leftover detections come back unmatched', () => {
    const confirmed: Array<{ x: number; y: number; width: number; height: number }> = []
    const detected = [{ box: [0, 0, 10, 10] as [number, number, number, number] }]

    const { pairs, unmatched } = matchBoxes(confirmed, detected)

    expect(pairs).toBeEmpty()
    expect(unmatched).toEqual(detected)
  })
})
