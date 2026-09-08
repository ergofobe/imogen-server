/**
 * Bounding-box geometry for matching a confirmed face to a fresh detection.
 *
 * Pure geometry, no database and no model involved — this is what lets `overlap.test.ts`
 * exercise the matching logic without Postgres or the detector's weights on disk.
 */

export type Box = { x: number; y: number; width: number; height: number }
type Detection = { box: [number, number, number, number] }

/**
 * The overlap fraction below which two boxes are treated as different faces. 0.5 is the
 * threshold `detect.ts` already uses to collapse duplicate detections of one face, for the
 * same reason: a face that moved a little between scans still shares most of its box with
 * itself, while two different faces rarely do.
 */
export const MATCH_IOU_THRESHOLD = 0.5

/** Intersection over union of two axis-aligned boxes; 0 when they do not overlap. */
export function iou(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.width, b.x + b.width)
  const y2 = Math.min(a.y + a.height, b.y + b.height)

  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const areaA = a.width * a.height
  const areaB = b.width * b.height
  return overlap / (areaA + areaB - overlap)
}

function toBox(box: [number, number, number, number]): Box {
  return { x: box[0], y: box[1], width: box[2] - box[0], height: box[3] - box[1] }
}

/**
 * Greedily pairs each confirmed box with its best-overlapping detection, each side used
 * at most once, so two confirmed faces can never both claim the same detection and one
 * detection can never refresh two confirmed rows.
 */
export function matchBoxes<C extends Box, D extends Detection>(
  confirmed: C[],
  detected: D[],
  threshold: number = MATCH_IOU_THRESHOLD,
): { pairs: Array<{ confirmed: C; detection: D }>; unmatched: D[] } {
  const candidates: Array<{ ci: number; di: number; score: number }> = []
  for (let ci = 0; ci < confirmed.length; ci++) {
    for (let di = 0; di < detected.length; di++) {
      const score = iou(confirmed[ci]!, toBox(detected[di]!.box))
      if (score >= threshold) candidates.push({ ci, di, score })
    }
  }
  candidates.sort((a, b) => b.score - a.score)

  const usedConfirmed = new Set<number>()
  const usedDetected = new Set<number>()
  const pairs: Array<{ confirmed: C; detection: D }> = []
  for (const { ci, di } of candidates) {
    if (usedConfirmed.has(ci) || usedDetected.has(di)) continue
    usedConfirmed.add(ci)
    usedDetected.add(di)
    pairs.push({ confirmed: confirmed[ci]!, detection: detected[di]! })
  }

  const unmatched = detected.filter((_, di) => !usedDetected.has(di))
  return { pairs, unmatched }
}
