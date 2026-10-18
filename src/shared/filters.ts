import type { Filters, Photo } from './types'
import { normalizeDateBound } from './date'

export interface FilterBounds {
  from: string
  to: string
  text: string
}

/** Normalise raw filter input into the canonical form used for matching. */
export function normalizeFilters(filters: Filters): FilterBounds {
  return {
    from: normalizeDateBound(filters.from),
    to: normalizeDateBound(filters.to),
    text: filters.text.trim().toLowerCase()
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

  return photos.filter((photo) => {
    if (bounds.text && !photo.name.toLowerCase().includes(bounds.text)) return false
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
