import type { Filters, Photo } from './types'
import { normalizeDateBound } from './date'

export interface FilterBounds {
  from: string
  to: string
  text: string
}

/**
 * Longest pattern accepted from the search box.
 *
 * The matcher compiles to a regex, and every literal run is escaped, so the only
 * unbounded construct is `.*`. A very long pattern with many wildcards would
 * still mean a very long regex to compile on every keystroke, so the input is
 * capped rather than allowed to grow without limit.
 */
export const MAX_PATTERN_LENGTH = 200

/**
 * Build a case-insensitive matcher for a file name.
 *
 * Two notations are supported, and the choice between them is made by the input
 * itself rather than by a mode switch:
 *
 * - with no wildcard character, the pattern is a **substring** match. That keeps
 *   the original behaviour — typing `kyoto` still finds `Kyoto Temple.jpg` —
 *   and it is what most people expect from a search box;
 * - with `*` or `?`, it becomes a **whole-name glob**: `*` matches any run of
 *   characters (including none), `?` matches exactly one. `*.jpg` and
 *   `IMG_????.jpg` therefore behave like the shell patterns they look like.
 *
 * Every character is escaped before it reaches the regex. A name such as
 * `IMG (1).jpg` or `a+b.jpg` is ordinary on disk, and passing it through
 * unescaped would either throw or match something unintended. Escaping also
 * removes the backtracking blow-ups a user-typed regex could cause.
 */
export function compileNamePattern(pattern: string): (name: string) => boolean {
  const raw = pattern.trim().toLowerCase().slice(0, MAX_PATTERN_LENGTH)
  if (!raw) return () => true

  const hasWildcard = raw.includes('*') || raw.includes('?')
  if (!hasWildcard) {
    // Plain substring: the common case, and cheaper than building a regex.
    return (name) => name.toLowerCase().includes(raw)
  }

  // `[^]*` rather than `.*` so a wildcard also spans newlines; file names do not
  // normally contain them, but a pattern should never fail to match for that.
  const source = raw
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^]*')
    .replace(/\?/g, '[^]')

  let matcher: RegExp
  try {
    matcher = new RegExp(`^${source}$`, 'i')
  } catch {
    // Unreachable after the escaping above, but a search box must never throw.
    return () => false
  }
  return (name) => matcher.test(name)
}

/** Normalise raw filter input into the canonical form used for matching. */
export function normalizeFilters(filters: Filters): FilterBounds {
  return {
    from: normalizeDateBound(filters.from),
    to: normalizeDateBound(filters.to),
    text: filters.text.trim()
  }
}

/** True when the filters would keep every photo. */
export function isFilterActive(bounds: FilterBounds): boolean {
  return bounds.from !== '' || bounds.to !== '' || bounds.text !== ''
}

/**
 * Apply the filters.
 *
 * A photo with no known capture date is only excluded when a date bound is
 * set: showing undated photos by default keeps the wall honest about what is
 * on disk, and hiding them would silently lose files.
 */
export function applyFilters(photos: readonly Photo[], filters: Filters): Photo[] {
  const bounds = normalizeFilters(filters)
  if (!isFilterActive(bounds)) return photos.slice()

  // Compiled once per call rather than once per photo: a folder of thousands of
  // files would otherwise rebuild the same regex thousands of times.
  const matches = compileNamePattern(bounds.text)

  return photos.filter((photo) => {
    if (bounds.text && !matches(photo.name)) return false
    if (bounds.from || bounds.to) {
      if (!photo.takenAt) return false
      if (bounds.from && photo.takenAt < bounds.from) return false
      if (bounds.to && photo.takenAt > bounds.to) return false
    }
    return true
  })
}

/** Inclusive date range actually present in the collection, for the picker hints. */
export function dateRange(photos: readonly Photo[]): { min: string; max: string } {
  let min = ''
  let max = ''
  for (const photo of photos) {
    if (!photo.takenAt) continue
    if (!min || photo.takenAt < min) min = photo.takenAt
    if (!max || photo.takenAt > max) max = photo.takenAt
  }
  return { min, max }
}
