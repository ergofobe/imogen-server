/**
 * Grouping faces into people.
 *
 * Thresholds come from measuring the models on real portraits: the same face under
 * different exposure, framing, rotation, and heavy compression scores 0.92 to 0.99,
 * while different people score between -0.07 and 0.12. Anything in the middle separates
 * them, so the number below is chosen for which mistake it prefers rather than for
 * where the data happens to sit.
 */
export const CLUSTER = {
  /**
   * How alike a face and a person must be to be grouped automatically.
   *
   * Set deliberately high. Splitting one person into two clusters is a mild annoyance
   * a user fixes with a merge; merging two people is a privacy failure that puts
   * somebody's photographs under another person's name. The measured gap is wide
   * enough that erring toward splitting costs almost nothing.
   */
  matchThreshold: 0.5,
  /** Faces below this detection confidence are too unreliable to group. */
  minDetectionScore: 0.65,
  /** A face smaller than this in the original is mostly noise. */
  minFaceSize: 48,
} as const

export type PersonCandidate = { id: string; centroid: Float32Array }

/** The most similar person above the threshold, or null to start a new one. */
export function bestMatch(
  face: Float32Array,
  candidates: PersonCandidate[],
): PersonCandidate | null {
  let best: PersonCandidate | null = null
  let bestScore: number = CLUSTER.matchThreshold

  for (const candidate of candidates) {
    const score = cosine(face, candidate.centroid)
    if (score >= bestScore) {
      best = candidate
      bestScore = score
    }
  }
  return best
}

/**
 * Folds a new face into a person's running mean.
 *
 * A mean rather than a stored list: matching then costs one index lookup instead of a
 * comparison against every photograph that person appears in, which is what keeps this
 * usable on a library with tens of thousands of faces.
 */
export function updateCentroid(
  centroid: Float32Array | null,
  faceCount: number,
  face: Float32Array,
): Float32Array {
  if (!centroid || faceCount === 0) return normalise(face)

  const out = new Float32Array(face.length)
  for (let i = 0; i < face.length; i++) {
    out[i] = (centroid[i]! * faceCount + face[i]!) / (faceCount + 1)
  }
  return normalise(out)
}

/**
 * Swaps one face's embedding for another in a person's running mean, for a confirmed
 * face re-embedded by a later scan. The alternative — re-reading every embedding the
 * person has and averaging again — is exact, but costs a read proportional to how often
 * they appear, per face, on every re-scan; the same approximation `updateCentroid`
 * already makes is good enough here.
 */
export function replaceInCentroid(
  centroid: Float32Array | null,
  faceCount: number,
  previous: Float32Array,
  replacement: Float32Array,
): Float32Array {
  if (!centroid || faceCount === 0) return normalise(replacement)

  const out = new Float32Array(replacement.length)
  for (let i = 0; i < replacement.length; i++) {
    out[i] = (centroid[i]! * faceCount - previous[i]! + replacement[i]!) / faceCount
  }
  return normalise(out)
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!
  return dot
}

function normalise(v: Float32Array): Float32Array {
  let norm = 0
  for (const x of v) norm += x * x
  norm = Math.sqrt(norm) || 1
  return new Float32Array(Array.from(v, (x) => x / norm))
}
