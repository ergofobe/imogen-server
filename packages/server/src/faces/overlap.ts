/**
 * Bounding-box geometry for matching a confirmed face to a fresh detection.
 *
 * Pure geometry, no database and no model involved — this is what lets `overlap.test.ts`
 * exercise the matching logic without Postgres or the detector's weights on disk.
 */

/** Corners, `[x1, y1, x2, y2]` — the form the detector emits. */
export type Corners = [number, number, number, number]
/** A stored face's box: origin and size, as the `faces` table keeps it. */
export type Box = { x: number; y: number; width: number; height: number }
type Detection = { box: Corners }

/**
 * The overlap fraction below which a stored face and a detection are treated as different
 * faces. A face that moved a little between scans — a re-decoded original, a slightly
 * different detector — still shares most of its box with itself, while two faces in one
 * photograph almost never do. Higher than the 0.4 non-max suppression uses in `detect.ts`
 * on purpose: that pass is collapsing duplicates of one detection, whereas a wrong match
 * here would hand a human's identification to somebody else's face.
 */
export const MATCH_IOU_THRESHOLD = 0.5

/** Intersection over union of two boxes; 0 when they do not overlap. */
export function iou(a: Corners, b: Corners): number {
  const x1 = Math.max(a[0], b[0])
  const y1 = Math.max(a[1], b[1])
  const x2 = Math.min(a[2], b[2])
  const y2 = Math.min(a[3], b[3])
  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const areaA = (a[2] - a[0]) * (a[3] - a[1])
  const areaB = (b[2] - b[0]) * (b[3] - b[1])
  return overlap / (areaA + areaB - overlap)
}

export function corners(box: Box): Corners {
  return [box.x, box.y, box.x + box.width, box.y + box.height]
}

/** The detector's corners as the `faces` table stores them: whole pixels of the original. */
export function storedBox(box: Corners): Box {
  return {
    x: Math.round(box[0]),
    y: Math.round(box[1]),
    width: Math.round(box[2] - box[0]),
    height: Math.round(box[3] - box[1]),
  }
}

/**
 * Greedily pairs each confirmed box with its best-overlapping detection, each side used
 * at most once, so two confirmed faces can never both claim the same detection and one
 * detection can never refresh two confirmed rows. What is left over comes back on both
 * sides: detections nobody claimed, and confirmed faces nothing was found near.
 */
export function matchBoxes<C extends Box, D extends Detection>(
  confirmed: C[],
  detected: D[],
  threshold: number = MATCH_IOU_THRESHOLD,
): { pairs: Array<{ confirmed: C; detection: D }>; unmatched: D[]; orphaned: C[] } {
  const candidates: Array<{ ci: number; di: number; score: number }> = []
  for (let ci = 0; ci < confirmed.length; ci++) {
    for (let di = 0; di < detected.length; di++) {
      const score = iou(corners(confirmed[ci]!), detected[di]!.box)
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

  return {
    pairs,
    unmatched: detected.filter((_, di) => !usedDetected.has(di)),
    orphaned: confirmed.filter((_, ci) => !usedConfirmed.has(ci)),
  }
}
