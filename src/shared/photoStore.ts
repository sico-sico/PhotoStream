import type { Photo, SortMode } from './types'
import { DEFAULT_SORT } from './types'

/**
 * Photo collection operations.
 *
 * These are pure so the incremental-update path (file watching) can be tested
 * without touching the filesystem: the messy part is "which photo changed",
 * not "how do I splice an array".
 */

/** Locale-aware name comparison, kept in one place so ties stay consistent. */
function byName(a: Photo, b: Photo): number {
  return a.name.localeCompare(b.name, 'zh-Hans-CN')
}

/**
 * Order the wall.
 *
 * Undated photos always go last, whichever direction is chosen: they have no
 * position in a timeline, and letting them lead a newest-first wall would put
 * the least informative photos at the top. Within the undated group the order
 * is by name, so it stays stable between runs and between disk scans.
 */
export function sortPhotos(photos: readonly Photo[], mode: SortMode = DEFAULT_SORT): Photo[] {
  const dated = photos.filter((photo) => photo.takenAt !== '')
  const undated = photos.filter((photo) => photo.takenAt === '')

  const byDate = (a: Photo, b: Photo): number => {
    if (a.takenAt !== b.takenAt) {
      const older = a.takenAt < b.takenAt ? -1 : 1
      return mode === 'taken-asc' ? older : -older
    }
    const name = byName(a, b)
    // A reversed date order keeps its direction for same-day photos too, so the
    // newest day reads newest-first rather than silently flipping mid-list.
    return mode === 'taken-desc' ? -name : name
  }

  const byNameOnly = (a: Photo, b: Photo): number => {
    const name = byName(a, b)
    return mode === 'name-desc' ? -name : name
  }

  // `name-*` modes ignore the capture date entirely: the user asked for the
  // file names, and interleaving by date would look arbitrary.
  if (mode === 'name-asc' || mode === 'name-desc') {
    return photos.slice().sort(byNameOnly)
  }

  return [...dated.sort(byDate), ...undated.sort(byNameOnly)]
}

/**
 * Insert or replace a photo, returning a new sorted array.
 *
 * Replacing by path (not by id alone) means a renamed file is treated as a
 * different photo, which is correct for a filesystem-backed wall.
 */
export function upsertPhoto(photos: readonly Photo[], photo: Photo, mode: SortMode = DEFAULT_SORT): Photo[] {
  const next = photos.slice()
  const index = next.findIndex((item) => item.path === photo.path)
  if (index === -1) next.push(photo)
  else next[index] = photo
  return sortPhotos(next, mode)
}

/** Remove the photo at `path`; returns the original array when nothing matched. */
export function removePhoto(photos: readonly Photo[], path: string): Photo[] {
  const index = photos.findIndex((item) => item.path === path)
  if (index === -1) return photos.slice()
  const next = photos.slice()
  next.splice(index, 1)
  return next
}

/** Look up a photo by its filesystem path. */
export function findPhoto(photos: readonly Photo[], path: string): Photo | undefined {
  return photos.find((item) => item.path === path)
}
