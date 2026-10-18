/**
 * Two-finger pinch maths for the single-photo viewer.
 *
 * Kept free of DOM types so the whole gesture is unit-testable. The component
 * only has to track which pointers are down; everything about distance,
 * midpoint and the incremental scale belongs here.
 */

/** One finger, in stage-local coordinates. */
export interface PinchPoint {
  x: number
  y: number
}

/**
 * What the gesture looked like when it started.
 *
 * `distance` is captured up front rather than recomputed later because a pointer
 * can be lifted mid-gesture: comparing against the original spread is what stops
 * the image from jumping when the two remaining fingers change distance.
 */
export interface PinchStart {
  distance: number
  midX: number
  midY: number
}

export const MIN_PINCH_DISTANCE = 12

export function distanceBetween(a: PinchPoint, b: PinchPoint): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.hypot(dx, dy)
}

export function midpoint(a: PinchPoint, b: PinchPoint): PinchPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/**
 * Record the starting spread and midpoint of a pinch.
 *
 * Returns `null` when the fingers are too close together: at that distance the
 * ratio between two distances is dominated by pointer noise, so a tiny wobble
 * would fling the zoom across its whole range.
 */
export function beginPinch(a: PinchPoint, b: PinchPoint): PinchStart | null {
  const distance = distanceBetween(a, b)
  if (!(distance >= MIN_PINCH_DISTANCE)) return null
  const mid = midpoint(a, b)
  return { distance, midX: mid.x, midY: mid.y }
}

/**
 * Scale multiplier for the current finger positions.
 *
 * Spreading the fingers apart enlarges the photo. A pinch that ends with the
 * same spread it started with returns exactly 1, so the gesture is idempotent.
 */
export function pinchScale(start: PinchStart, a: PinchPoint, b: PinchPoint): number {
  const distance = distanceBetween(a, b)
  if (!(distance > 0) || !(start.distance > 0)) return 1
  const ratio = distance / start.distance
  // A single bad frame (one pointer reporting 0,0) must not blank the photo.
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1
}

/**
 * Whether a pointer pair should be treated as a pinch rather than a pan.
 *
 * Two pointers anywhere in the stage mean the user is pinching; a second
 * pointer arriving mid-drag must cancel the pan instead of being read as an
 * enormous one-frame movement.
 */
export function isPinch(count: number): boolean {
  return count >= 2
}
