/**
 * Latitude and longitude carry different bounds, and a number outside its own is not a
 * place: every SDK port decodes such a location away, so a row that kept one would hold a
 * location no client will ever show and nobody is ever told to correct.
 *
 * NaN needs the same answer for a different reason. A GPS rational with a zero denominator
 * decodes to exactly that, `typeof NaN` is 'number', and `JSON.stringify` writes it out as
 * `null` because JSON has no NaN literal -- handing a client a location object with a null
 * coordinate, which no port's model allows. Both comparisons below are false for NaN and
 * for an infinity, so one guard settles all of it.
 */
function isWithin(value: number | null | undefined, bound: number): value is number {
  return typeof value === 'number' && value >= -bound && value <= bound
}

export function isPlaceableLatitude(value: number | null | undefined): value is number {
  return isWithin(value, 90)
}

export function isPlaceableLongitude(value: number | null | undefined): value is number {
  return isWithin(value, 180)
}

/** Altitude has no bound of its own: a photograph from an aeroplane is still of somewhere. */
export function isUsableAltitude(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
