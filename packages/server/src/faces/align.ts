import { openOriginal } from '../media/decode.ts'

/**
 * ArcFace's canonical five-point template, in the 112x112 space every embedding is
 * computed in: both eyes, nose tip, both mouth corners. Aligning to this is what makes
 * two photographs of one person comparable at all — recognition accuracy depends far
 * more on consistent alignment than on crop quality.
 */
const TEMPLATE: Array<[number, number]> = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
]

export const FACE_SIZE = 112

type Similarity = { a: number; b: number; tx: number; ty: number }

/**
 * Least-squares similarity transform (rotation, uniform scale, translation) taking the
 * detected landmarks onto the template.
 *
 * For 2D this has a closed form — treat each point as a complex number and the fit is a
 * single division — so there is no need for an SVD to get the same answer Umeyama gives.
 */
export function similarityTransform(from: Array<[number, number]>): Similarity {
  const n = from.length
  const mean = (points: Array<[number, number]>, i: 0 | 1) =>
    points.reduce((sum, p) => sum + p[i], 0) / n

  const fx = mean(from, 0)
  const fy = mean(from, 1)
  const tx0 = mean(TEMPLATE, 0)
  const ty0 = mean(TEMPLATE, 1)

  let num1 = 0
  let num2 = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    const x = from[i]![0] - fx
    const y = from[i]![1] - fy
    const u = TEMPLATE[i]![0] - tx0
    const v = TEMPLATE[i]![1] - ty0
    num1 += x * u + y * v
    num2 += x * v - y * u
    den += x * x + y * y
  }

  const a = num1 / den
  const b = num2 / den
  return { a, b, tx: tx0 - (a * fx - b * fy), ty: ty0 - (b * fx + a * fy) }
}

/**
 * Produces the aligned 112x112 crop by sampling the source directly.
 *
 * Doing the sampling here rather than through an image library's affine keeps the output
 * canvas exactly 112x112 with the landmarks exactly on the template, instead of depending
 * on how a library chooses to size and offset a transformed bounding box.
 */
export async function alignFace(
  imagePath: string,
  landmarks: Array<[number, number]>,
): Promise<Float32Array> {
  // Upright, to match the frame the landmarks were detected in.
  const { data, info } = await openOriginal(imagePath)
    .rotate()
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const { a, b, tx, ty } = similarityTransform(landmarks)

  // Invert the similarity to map each output pixel back into the source.
  const det = a * a + b * b
  const ia = a / det
  const ib = -b / det

  const out = new Float32Array(3 * FACE_SIZE * FACE_SIZE)
  const plane = FACE_SIZE * FACE_SIZE
  const { width, height, channels } = info

  for (let v = 0; v < FACE_SIZE; v++) {
    for (let u = 0; u < FACE_SIZE; u++) {
      const dx = u - tx
      const dy = v - ty
      const x = ia * dx - ib * dy
      const y = ib * dx + ia * dy

      const [r, g, bl] = sampleBilinear(data, width, height, channels, x, y)
      const i = v * FACE_SIZE + u
      out[i] = (r - 127.5) / 127.5
      out[plane + i] = (g - 127.5) / 127.5
      out[2 * plane + i] = (bl - 127.5) / 127.5
    }
  }
  return out
}

/** Bilinear sampling, clamped at the edges so a face at the border still aligns. */
function sampleBilinear(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  x: number,
  y: number,
): [number, number, number] {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0

  const at = (px: number, py: number, c: number) => {
    const cx = Math.min(width - 1, Math.max(0, px))
    const cy = Math.min(height - 1, Math.max(0, py))
    return data[(cy * width + cx) * channels + c]!
  }

  const out: [number, number, number] = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    const top = at(x0, y0, c) * (1 - fx) + at(x0 + 1, y0, c) * fx
    const bottom = at(x0, y0 + 1, c) * (1 - fx) + at(x0 + 1, y0 + 1, c) * fx
    out[c] = top * (1 - fy) + bottom * fy
  }
  return out
}
