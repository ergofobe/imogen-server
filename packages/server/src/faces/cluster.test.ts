import { describe, expect, test } from 'bun:test'
import { bestMatch, CLUSTER, cosine, replaceInCentroid, updateCentroid } from './cluster.ts'

/** A unit vector pointing mostly along one axis, with a little noise on the next. */
function vec(axis: number, drift = 0): Float32Array {
  const v = new Float32Array(512)
  v[axis] = 1
  v[(axis + 1) % 512] = drift
  let norm = 0
  for (const x of v) norm += x * x
  norm = Math.sqrt(norm)
  return new Float32Array(Array.from(v, (x) => x / norm))
}

describe('matching a face to an existing person', () => {
  test('joins the person it genuinely resembles', () => {
    const candidates = [
      { id: 'anna', centroid: vec(0) },
      { id: 'ben', centroid: vec(200) },
    ]

    expect(bestMatch(vec(0, 0.05), candidates)?.id).toBe('anna')
  })

  test('starts a new person when nothing is close enough', () => {
    const candidates = [{ id: 'anna', centroid: vec(0) }]

    expect(bestMatch(vec(200), candidates)).toBeNull()
  })

  test('has nobody to match against in an empty library', () => {
    expect(bestMatch(vec(0), [])).toBeNull()
  })

  test('picks the closest when two people are both plausible', () => {
    const candidates = [
      { id: 'near', centroid: vec(0, 0.02) },
      { id: 'far', centroid: vec(0, 0.4) },
    ]

    expect(bestMatch(vec(0), candidates)?.id).toBe('near')
  })

  /**
   * Splitting one person into two is a mild annoyance; merging two people is a privacy
   * failure. The threshold is deliberately set so the first happens before the second.
   */
  test('refuses a match that only just misses the threshold', () => {
    const almost = CLUSTER.matchThreshold - 0.02
    const candidate = { id: 'anna', centroid: vec(0) }
    const face = mix(vec(0), vec(300), almost)

    expect(bestMatch(face, [candidate])).toBeNull()
  })

  test('accepts a match comfortably over the threshold', () => {
    const candidate = { id: 'anna', centroid: vec(0) }
    const face = mix(vec(0), vec(300), CLUSTER.matchThreshold + 0.05)

    expect(bestMatch(face, [candidate])?.id).toBe('anna')
  })
})

describe('keeping a person’s centroid current', () => {
  test('a person’s first face becomes their centroid', () => {
    const face = vec(0)

    const centroid = updateCentroid(null, 0, face)

    expect(similarity(centroid, face)).toBeCloseTo(1, 5)
  })

  test('the centroid stays a unit vector as faces are added', () => {
    let centroid = updateCentroid(null, 0, vec(0))
    centroid = updateCentroid(centroid, 1, vec(0, 0.1))
    centroid = updateCentroid(centroid, 2, vec(0, 0.2))

    let norm = 0
    for (const v of centroid) norm += v * v
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5)
  })

  test('it moves toward each new face, but only a little when many exist', () => {
    const start = updateCentroid(null, 0, vec(0))
    const afterFew = updateCentroid(start, 1, vec(0, 0.5))
    const afterMany = updateCentroid(start, 200, vec(0, 0.5))

    // With two hundred faces already, one more should barely move it.
    expect(similarity(afterMany, start)).toBeGreaterThan(similarity(afterFew, start))
  })
})

/**
 * A unit vector whose cosine similarity with `a` is exactly `target`.
 *
 * For orthogonal unit vectors, target*a + sqrt(1 - target^2)*b is already unit length,
 * so the similarity is the target itself. Mixing by weight and normalising afterwards
 * does not give the weight back, which is a good way to write a test that passes for
 * the wrong reason.
 */
function mix(a: Float32Array, b: Float32Array, target: number): Float32Array {
  const other = Math.sqrt(1 - target * target)
  const out = new Float32Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i]! * target + b[i]! * other
  return out
}

function similarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!
  return dot
}

describe('replacing one face in a person', () => {
  test('moves the mean by the difference between the old face and the new one', () => {
    const centroid = updateCentroid(updateCentroid(null, 0, vec(0)), 1, vec(200))

    const swapped = replaceInCentroid(centroid, 2, vec(0), vec(100))

    // The person is now faces 100 and 200: near both, and away from the face that left.
    // Chosen so that "just take the new face" would sit on 100 and nowhere near 200, and
    // swapping the arguments would point away from 100 entirely.
    expect(cosine(swapped, vec(100))).toBeGreaterThan(0.5)
    expect(cosine(swapped, vec(200))).toBeGreaterThan(0.5)
    expect(cosine(swapped, vec(0))).toBeLessThan(cosine(centroid, vec(0)) / 2)
  })

  test('is the new face alone when the person had no centroid yet', () => {
    expect(Array.from(replaceInCentroid(null, 0, vec(0), vec(3)))).toEqual(Array.from(vec(3)))
  })
})
