/**
 * Scrollbar geometry for the photo wall.
 *
 * A 3226-photo wall is ~140000 world pixels tall. Dragging is fine for small
 * movements, but reaching a specific point in a year of photos needs a
 * proportional control, which is what this module computes.
 *
 * Everything is expressed in fractions rather than pixels so the same maths
 * drives the thumb position, its length, and the reverse mapping used while
 * dragging. The caller multiplies by the track's pixel height.
 */

import type { Transform } from './transform'

export interface ScrollMetrics {
  /** Position of the thumb, as a fraction of the track, from the top. */
  offset: number
  /** Length of the thumb, as a fraction of the track. 0 when it would vanish. */
  size: number
  /** Whether the wall is taller than the viewport at all. */
  scrollable: boolean
}

/**
 * Smallest thumb, as a fraction of the track.
 *
 * A very tall wall would otherwise compute a thumb of a few pixels, which is
 * both hard to grab and impossible to see. Clamping the *visual* size is
 * standard practice; the offset still maps linearly across the remaining track.
 */
export const MIN_THUMB_FRACTION = 0.06

/**
 * Measure the scrollbar for the current view.
 *
 * @param transform     current pan/zoom
 * @param worldHeight   the wall's height in world units
 * @param viewportHeight window height in CSS pixels
 */
export function scrollMetrics(transform: Transform, worldHeight: number, viewportHeight: number): ScrollMetrics {
  if (!(worldHeight > 0) || !(viewportHeight > 0)) return { offset: 0, size: 1, scrollable: false }

  const scale = transform.scale > 0 ? transform.scale : 1
  const scaledHeight = worldHeight * scale
  if (scaledHeight <= viewportHeight + 1) {
    // The whole wall is on screen: a scrollbar would be a lie.
    return { offset: 0, size: 1, scrollable: false }
  }

  const size = Math.max(MIN_THUMB_FRACTION, viewportHeight / scaledHeight)
  // Usable travel is what is left of the track once the thumb occupies its part.
  const travel = 1 - size
  // The wall can pan between `viewportHeight - scaledHeight` (bottom) and 0
  // (top), which is exactly `scaledHeight - viewportHeight` of movement.
  const scrolled = (0 - transform.y) / (scaledHeight - viewportHeight)
  const offset = Math.min(Math.max(scrolled, 0), 1) * travel

  return { offset, size, scrollable: true }
}

/**
 * Convert a thumb position back into a vertical translate.
 *
 * Inverse of `scrollMetrics`: given where the user dragged the thumb, this
 * returns the `y` that puts the corresponding part of the wall at the top of
 * the window.
 *
 * @param offset fraction of the track the thumb's top sits at
 */
export function scrollOffsetToY(offset: number, worldHeight: number, viewportHeight: number, scale: number): number {
  if (!(worldHeight > 0) || !(viewportHeight > 0)) return 0
  const effectiveScale = scale > 0 ? scale : 1
  const scaledHeight = worldHeight * effectiveScale
  if (scaledHeight <= viewportHeight + 1) return 0

  const size = Math.max(MIN_THUMB_FRACTION, viewportHeight / scaledHeight)
  const travel = 1 - size
  if (!(travel > 0)) return 0

  const scrolled = Math.min(Math.max(offset / travel, 0), 1)
  // Positive `scrolled` moves the wall up, hence the negative sign.
  return -scrolled * (scaledHeight - viewportHeight)
}

/**
 * The `y` that puts a given world row at the top of the window.
 *
 * Used by "jump to date": the caller knows where that date's first photo sits
 * vertically, and this returns the translate to bring it into view. Only the
 * vertical axis is computed — the horizontal position belongs to the caller,
 * and overwriting it would throw away where the user was looking sideways.
 */
export function scrollToWorldY(worldY: number, scale: number): number {
  const effectiveScale = scale > 0 ? scale : 1
  return -worldY * effectiveScale
}

/**
 * The capture date of the photo shown at the top of the window.
 *
 * While the thumb is dragged there is no reason to mount the tiles it passes, so
 * the date is read from the layout rather than the DOM. The library can span
 * years; showing which month the thumb just landed on is what makes the
 * scrollbar useful for navigation rather than only for travel.
 *
 * @returns `YYYY-MM-DD`, or `''` when nothing at that row is dated
 */
export function dateAtWorldY(
  items: readonly { y: number; h: number; takenAt: string }[],
  worldY: number
): string {
  if (items.length === 0) return ''

  // Items are in layout order, which for the wall is date order too. The first
  // item still on screen at that row is the one the viewport starts on.
  for (const item of items) {
    if (item.y + item.h < worldY) continue
    if (item.takenAt) return item.takenAt
  }

  // That row holds only undated photos: fall back to the nearest dated photo
  // above it, which keeps the label meaningful instead of blank.
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].y <= worldY && items[index].takenAt) return items[index].takenAt
  }
  return ''
}

/** First world row at which each distinct date starts, for the date rail. */
export function dateMarkers(
  items: readonly { y: number; takenAt: string }[]
): Array<{ date: string; y: number }> {
  const markers: Array<{ date: string; y: number }> = []
  const seen = new Set<string>()
  for (const item of items) {
    if (!item.takenAt || seen.has(item.takenAt)) continue
    seen.add(item.takenAt)
    markers.push({ date: item.takenAt, y: item.y })
  }
  return markers
}
