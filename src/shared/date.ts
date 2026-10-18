/**
 * Date helpers.
 *
 * EXIF stores `DateTimeOriginal` as a *local* wall-clock string such as
 * `2006:05:12 21:06:51`. Feeding that into `new Date()` treats it as UTC on
 * some runtimes and local on others, which silently shifts the calendar day.
 * Everything here therefore works on the raw string and never converts through
 * a `Date` for the day part.
 *
 * Date *formatting* lives in `@shared/i18n` so it follows the active language.
 */

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/** True when `y-m-d` is a real calendar date. */
export function isValidDate(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1) return false
  const max = m === 2 && isLeapYear(y) ? 29 : MONTH_LENGTHS[m - 1]
  return d <= max
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function toIsoDate(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`
}

/** Matches `2006:05:12 21:06:51`, `2006-05-12 21:06:51`, optionally with fractional seconds. */
const EXIF_DATETIME = /^(\d{4})[-:](\d{1,2})[-:](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/

/**
 * Convert an EXIF date/time string into `YYYY-MM-DD` using its own wall-clock
 * values. Returns `''` for anything unparseable, including EXIF's documented
 * `0000:00:00 00:00:00` placeholder.
 */
export function exifDateToIsoDate(value: unknown): string {
  if (typeof value !== 'string') return ''
  const match = EXIF_DATETIME.exec(value.trim())
  if (!match) return ''
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  const hh = Number(match[4])
  const mm = Number(match[5])
  if (!isValidDate(y, m, d)) return ''
  if (hh > 23 || mm > 59) return ''
  return toIsoDate(y, m, d)
}

/** Normalise a user-entered `YYYY-MM-DD` bound, or `''` when it is not a valid date. */
export function normalizeDateBound(value: string): string {
  if (!value) return ''
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value.trim())
  if (!match) return ''
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  if (!isValidDate(y, m, d)) return ''
  return toIsoDate(y, m, d)
}
