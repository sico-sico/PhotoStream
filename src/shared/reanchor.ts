/**
 * Keeping the view anchored when the wall is re-laid out.
 *
 * Zooming out re-lays the wall at a wider container so the columns fill the
 * window instead of leaving empty bands at the sides. That moves every tile,
 * so the transform has to be recomputed or the view appears to jump — users
 * reported it as "zooming sends me back to the first photo".
 *
 * The rule: whatever was in the middle of the window stays in the middle of the
 * window. Keeping a specific photo under the cursor would be better still, but
 * the pointer position is not available here, and the centre is what the eye is
 * usually tracking anyway.
 */

import type { LayoutItem, LayoutResult } from './layout'
import type { Transform } from './transform'

/** The photo whose centre is closest to a world point. */
export function nearestItem(
  items: readonly LayoutItem[],
  point: { x: number; y: number }
): LayoutItem | null {
  let best: LayoutItem | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const item of items) {
    const distance = Math.hypot(item.x + item.w / 2 - point.x, item.y + item.h / 2 - point.y)
    if (distance < bestDistance) {
      bestDistance = distance
      best = item
    }
  }
  return best
}

/**
 * Re-anchor a transform after the layout changed.
 *
 * @param previous the transform used with the old layout
 * @param oldLayout layout that `previous` was valid for
 * @param newLayout layout the wall now uses
 * @param viewport  window size in CSS pixels
 * @returns a transform that keeps the same photo centred, at the same zoom
 */
export function reanchorTransform(
  previous: Transform,
  oldLayout: Pick<LayoutResult, 'items'>,
  newLayout: Pick<LayoutResult, 'items'>,
  viewport: { width: number; height: number }
): Transform {
  const scale = previous.scale > 0 ? previous.scale : 1
  const centreOfView = {
    x: (viewport.width / 2 - previous.x) / scale,
    y: (viewport.height / 2 - previous.y) / scale
  }

  const anchor = nearestItem(oldLayout.items, centreOfView)
  // With no photos there is nothing to hold on to; the old transform is as good
  // an answer as any and avoids inventing a position.
  if (!anchor) return previous

  // The same photo keeps its identity, so find where it sits now.
  const moved = newLayout.items.find((item) => item.id === anchor.id)
  if (!moved) return previous

  const target = { x: moved.x + moved.w / 2, y: moved.y + moved.h / 2 }
  return {
    scale: previous.scale,
    x: viewport.width / 2 - target.x * scale,
    y: viewport.height / 2 - target.y * scale
  }
}
