import ort from 'onnxruntime-node'
import { openOriginal } from '../media/decode.ts'

/**
 * SCRFD decoding. The model emits, for each of three strides, a score map, a distance
 * map (left/top/right/bottom from each anchor point), and five keypoints. Turning those
 * into boxes means walking the anchor grid for each stride and adding the distances back
 * to the anchor centre.
 */
const STRIDES = [8, 16, 32]
const ANCHORS_PER_POINT = 2
const INPUT = 640

export type Face = {
  box: [number, number, number, number]
  score: number
  /** Five landmarks: both eyes, nose, both mouth corners. Used to align before embedding. */
  keypoints: Array<[number, number]>
}

export async function detect(
  session: ort.InferenceSession,
  imagePath: string,
  threshold = 0.5,
): Promise<{ faces: Face[]; scale: number; width: number; height: number }> {
  /*
   * `.rotate()` with no argument applies the EXIF orientation, so detection sees the
   * photo the right way up — the same way the preview and every viewer does. Without it,
   * coordinates come back in the stored frame, and a box drawn over a rotated photo
   * lands somewhere else entirely.
   */
  const upright = () => openOriginal(imagePath).rotate()

  const meta = await openOriginal(imagePath).metadata()
  // Orientations 5 to 8 involve a quarter turn, so the upright image is the stored one
  // transposed. Reading the tag is far cheaper than decoding the pixels to find out.
  const turned = (meta.orientation ?? 1) >= 5
  const width = turned ? meta.height! : meta.width!
  const height = turned ? meta.width! : meta.height!

  // Letterbox into a square, keeping aspect so the boxes map back cleanly.
  const scale = INPUT / Math.max(width, height)
  const resizedW = Math.round(width * scale)
  const resizedH = Math.round(height * scale)

  const { data } = await upright()
    .resize(resizedW, resizedH, { fit: 'fill' })
    .extend({
      top: 0,
      left: 0,
      bottom: INPUT - resizedH,
      right: INPUT - resizedW,
      background: { r: 0, g: 0, b: 0 },
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  // SCRFD wants RGB planar, normalised as (x - 127.5) / 128.
  const tensor = new Float32Array(3 * INPUT * INPUT)
  const plane = INPUT * INPUT
  for (let i = 0; i < plane; i++) {
    tensor[i] = (data[i * 3]! - 127.5) / 128
    tensor[plane + i] = (data[i * 3 + 1]! - 127.5) / 128
    tensor[2 * plane + i] = (data[i * 3 + 2]! - 127.5) / 128
  }

  const outputs = await session.run({
    [session.inputNames[0]!]: new ort.Tensor('float32', tensor, [1, 3, INPUT, INPUT]),
  })

  // Outputs arrive grouped: scores for all strides, then boxes, then keypoints.
  const names = session.outputNames
  const faces: Face[] = []

  for (let s = 0; s < STRIDES.length; s++) {
    const stride = STRIDES[s]!
    const scores = outputs[names[s]!]!.data as Float32Array
    const boxes = outputs[names[s + 3]!]!.data as Float32Array
    const kps = outputs[names[s + 6]!]!.data as Float32Array

    const cells = INPUT / stride
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        for (let a = 0; a < ANCHORS_PER_POINT; a++) {
          const index = (y * cells + x) * ANCHORS_PER_POINT + a
          const score = scores[index]!
          if (score < threshold) continue

          const cx = x * stride
          const cy = y * stride
          const o = index * 4
          const box: [number, number, number, number] = [
            (cx - boxes[o]! * stride) / scale,
            (cy - boxes[o + 1]! * stride) / scale,
            (cx + boxes[o + 2]! * stride) / scale,
            (cy + boxes[o + 3]! * stride) / scale,
          ]

          const k = index * 10
          const keypoints: Array<[number, number]> = []
          for (let p = 0; p < 5; p++) {
            keypoints.push([
              (cx + kps[k + p * 2]! * stride) / scale,
              (cy + kps[k + p * 2 + 1]! * stride) / scale,
            ])
          }

          faces.push({ box, score, keypoints })
        }
      }
    }
  }

  return { faces: nonMaxSuppression(faces, 0.4), scale, width, height }
}

/** Overlapping detections of the same face collapse to the most confident one. */
function nonMaxSuppression(faces: Face[], iouThreshold: number): Face[] {
  const sorted = [...faces].sort((a, b) => b.score - a.score)
  const kept: Face[] = []

  for (const candidate of sorted) {
    if (kept.some((k) => iou(k.box, candidate.box) > iouThreshold)) continue
    kept.push(candidate)
  }
  return kept
}

function iou(a: [number, number, number, number], b: [number, number, number, number]): number {
  const x1 = Math.max(a[0], b[0])
  const y1 = Math.max(a[1], b[1])
  const x2 = Math.min(a[2], b[2])
  const y2 = Math.min(a[3], b[3])
  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const areaA = (a[2] - a[0]) * (a[3] - a[1])
  const areaB = (b[2] - b[0]) * (b[3] - b[1])
  return overlap / (areaA + areaB - overlap)
}

export function similarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!
  return dot
}
