import type { Photo } from './types'

/**
 * Photo collection operations.
 *
 * These are pure so the incremental-update path (file watching) can be tested
 * without touching the filesystem: the messy part is "which photo changed",
 * not "how do I splice an array".
 */

/** Sort by capture date (oldest first), then name; undated photos go last. */
export function sortPhotos(photos: readonly Photo[]): Photo[] {
  return photos.slice().sort((a, b) => {
    if (a.takenAt && b.takenAt) {
      if (a.takenAt !== b.takenAt) return a.takenAt < b.takenAt ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-Hans-CN')
    }
    if (a.takenAt) return -1
    if (b.takenAt) return 1
    return a.name.localeCompare(b.name, 'zh-Hans-CN')
  })
}

/**
 * Insert or replace a photo, returning a new sorted array.
 * Replacing by path (not by id alone) means a renamed file is treated as a
 * different photo, which is correct for a filesystem-backed wall.
 */
export function upsertPhoto(photos: readonly Photo[], photo: Photo): Photo[] {
  const next = photos.slice()
  const index = next.findIndex((item) => item.path === photo.path)
  if (index === -1) next.push(photo)
  else next[index] = photo
  return sortPhotos(next)
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
