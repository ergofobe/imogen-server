const DAY = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
const DAY_WITH_YEAR = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
})
const DAY_UTC = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
})
const DAY_WITH_YEAR_UTC = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})
const MONTH_YEAR = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' })
const EXACT = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' })

/** Omits the year for photos from this year, the way a person would say the date aloud. */
export function formatDayHeading(iso: string): string {
  const date = new Date(iso)
  const thisYear = date.getFullYear() === new Date().getFullYear()
  return (thisYear ? DAY : DAY_WITH_YEAR).format(date)
}

/**
 * The same heading, for a `YYYY-MM-DD` day key rather than an instant.
 *
 * The server buckets on UTC days and the whole timeline is keyed on them, so the heading
 * has to be read in UTC too: formatting `2011-08-14` anywhere behind UTC would title the
 * section with the thirteenth while every photograph under it belongs to the fourteenth.
 */
export function formatDayKeyHeading(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`)
  const thisYear = date.getUTCFullYear() === new Date().getUTCFullYear()
  return (thisYear ? DAY_UTC : DAY_WITH_YEAR_UTC).format(date)
}

export const formatMonthYear = (iso: string) => MONTH_YEAR.format(new Date(iso))
export const formatExact = (iso: string) => EXACT.format(new Date(iso))

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

export function formatDuration(seconds: number): string {
  const total = Math.round(seconds)
  const minutes = Math.floor(total / 60)
  const remainder = total % 60
  return `${minutes}:${String(remainder).padStart(2, '0')}`
}

/** Renders an aperture as photographers write it, not as a raw number. */
export function formatAperture(fNumber: number): string {
  return `ƒ/${fNumber % 1 === 0 ? fNumber : fNumber.toFixed(1)}`
}

export function formatShutter(seconds: number): string {
  if (seconds >= 1) return `${seconds.toFixed(1)}s`
  return `1/${Math.round(1 / seconds)}s`
}

/** Groups assets into day buckets, preserving the order they arrived in. */
export function groupByDay<T extends { capturedAt: string }>(items: T[]): Array<[string, T[]]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const key = item.capturedAt.slice(0, 10)
    const bucket = groups.get(key)
    if (bucket) bucket.push(item)
    else groups.set(key, [item])
  }
  return [...groups.entries()]
}
