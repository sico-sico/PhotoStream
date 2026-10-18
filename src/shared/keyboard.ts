/**
 * Keyboard panning for the photo wall.
 *
 * Arrow keys nudge the wall by a fraction of the viewport, which is the same
 * mental model as a scrollable document: one press moves one noticeable step,
 * holding the key repeats it. The step is a share of the *viewport* rather than
 * a fixed pixel count so the movement feels the same at any zoom and window
 * size.
 */

import type { Transform } from './transform'

/** Share of the viewport moved per key press. */
export const KEY_PAN_FRACTION = 0.18

/**
 * Modifier that triggers a large step.
 *
 * Hold Shift for a full page; this mirrors browsers and file managers, and makes
 * crossing a long library bearable without holding the key for seconds.
 */
export const KEY_PAN_LARGE_FRACTION = 0.9

export type PanKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'

const ARROWS: ReadonlySet<string> = new Set<PanKey>(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])

export function isPanKey(key: string): key is PanKey {
  return ARROWS.has(key)
}

/**
 * Transform for a key press.
 *
 * The wall moves *against* the arrow direction the way a document scrolls: the
 * right arrow reveals what is to the right, which means translating the wall
 * leftwards. Doing the opposite (moving the wall right) feels like dragging the
 * paper instead of reading it.
 *
 * @param shift true when a large step was requested
 */
export function panByKey(
  transform: Transform,
  key: PanKey,
  viewport: { width: number; height: number },
  shift = false
): Transform {
  const fraction = shift ? KEY_PAN_LARGE_FRACTION : KEY_PAN_FRACTION
  // The `max` sits outside `round`: rounding a 0.4px step on a 2px-wide window
  // would otherwise produce 0 and make the key appear dead.
  const stepX = Math.max(1, Math.round(Math.max(1, viewport.width) * fraction))
  const stepY = Math.max(1, Math.round(Math.max(1, viewport.height) * fraction))

  switch (key) {
    case 'ArrowLeft':
      return { ...transform, x: transform.x + stepX }
    case 'ArrowRight':
      return { ...transform, x: transform.x - stepX }
    case 'ArrowUp':
      return { ...transform, y: transform.y + stepY }
    case 'ArrowDown':
      return { ...transform, y: transform.y - stepY }
  }
}

/**
 * Nearest tile in a direction, for arrow-key selection.
 *
 * "Nearest" is not simply the next index: the wall is justified, so a photo can
 * have a much wider neighbour one row down. Picking by geometry means the arrow
 * that *looks* like it points at a photo actually selects it.
 *
 * @param items laid out tiles, in reading order
 * @param from  the currently selected tile
 * @returns the id of the neighbour, or null when there is nothing further
 */
export function neighbourInDirection(
  items: readonly { id: string; x: number; y: number; w: number; h: number }[],
  from: { id: string; x: number; y: number; w: number; h: number },
  key: PanKey
): string | null {
  const centreX = from.x + from.w / 2
  const centreY = from.y + from.h / 2
  // A candidate must be meaningfully in the requested direction, otherwise a
  // same-row tile would win every horizontal comparison.
  const EPSILON = 1

  let best: { id: string; score: number } | null = null

  for (const item of items) {
    if (item.id === from.id) continue
    const dx = item.x + item.w / 2 - centreX
    const dy = item.y + item.h / 2 - centreY

    let along: number
    let across: number
    switch (key) {
      case 'ArrowLeft':
        if (dx > -EPSILON) continue
        along = -dx
        across = Math.abs(dy)
        break
      case 'ArrowRight':
        if (dx < EPSILON) continue
        along = dx
        across = Math.abs(dy)
        break
      case 'ArrowUp':
        if (dy > -EPSILON) continue
        along = -dy
        across = Math.abs(dx)
        break
      case 'ArrowDown':
        if (dy < EPSILON) continue
        along = dy
        across = Math.abs(dx)
        break
    }

    // Prefer the closest step forward, and among those the one least off-axis.
    // Weighting the sideways distance keeps a straight-down arrow from jumping
    // to a tile that is three columns away but one row closer.
    const score = along + across * 2
    if (!best || score < best.score) best = { id: item.id, score }
  }

  return best?.id ?? null
}

/**
 * Centre the wall on a point, without changing the zoom.
 *
 * Used to bring the focused photo into view after an arrow-key selection step,
 * so the highlighted tile is never off screen.
 */
export function centerOn(
  transform: Transform,
  target: { x: number; y: number },
  viewport: { width: number; height: number }
): Transform {
  const scale = transform.scale > 0 ? transform.scale : 1
  return {
    scale: transform.scale,
    x: viewport.width / 2 - target.x * scale,
    y: viewport.height / 2 - target.y * scale
  }
}

/**
 * Whether a world point is comfortably inside the viewport.
 *
 * @param margin fraction of the viewport that counts as "too close to the edge";
 *   scrolling only when the target is nearly off screen avoids pointless
 *   movement when the user is stepping through a visible row.
 */
export function isComfortablyVisible(
  transform: Transform,
  target: { x: number; y: number },
  viewport: { width: number; height: number },
  margin = 0.15
): boolean {
  const scale = transform.scale > 0 ? transform.scale : 1
  const screenX = target.x * scale + transform.x
  const screenY = target.y * scale + transform.y
  const insetX = viewport.width * margin
  const insetY = viewport.height * margin
  return (
    screenX >= insetX &&
    screenX <= viewport.width - insetX &&
    screenY >= insetY &&
    screenY <= viewport.height - insetY
  )
}
