/**
 * Viewport culling for the photo wall.
 *
 * The wall renders one DOM node per photo. Measured on the 3226-photo sample
 * library, a transform-only pan took 27 ms per frame with every tile mounted and
 * 17 ms with only 200 — the compositor is not the problem, the sheer number of
 * live nodes is. Culling to what is on screen is therefore what makes dragging
 * smooth, not a transform optimisation.
 *
 * Everything here is pure so the margin and the scale arithmetic can be tested
 * without a browser.
 */

import type { LayoutItem, LayoutResult } from './layout'
import type { Transform } from './transform'

export interface CullResult {
  /** Items that should be mounted, in layout order. */
  items: LayoutItem[]
  /** Ids of the mounted items, for thumbnail requests. */
  ids: Set<string>
}

/**
 * Screen pixels of extra content kept mounted beyond each viewport edge.
 *
 * One viewport-worth of margin means a fast fling still has content ready before
 * it arrives, while the mounted set stays around 2-3 screens. Expressing it in
 * screen pixels (not world pixels) keeps the count stable at any zoom, which
 * matters because zooming out would otherwise select the entire library.
 */
export const CULL_MARGIN = 900

/**
 * Hard cap on mounted tiles.
 *
 * A pathological case (a very tall narrow window, or a zoom level that fits
 * thousands of tiles) must not silently reintroduce the original slowness, so
 * the set is truncated by distance from the viewport centre rather than by
 * layout order: the nearest tiles are the ones the user is looking at.
 */
export const MAX_MOUNTED_TILES = 600

/** Visible world rectangle for a transform, in world coordinates. */
export function worldRect(
  transform: Transform,
  viewportWidth: number,
  viewportHeight: number,
  margin: number
): { left: number; top: number; right: number; bottom: number } {
  const scale = transform.scale > 0 ? transform.scale : 1
  // Screen (0,0) is world (0,0) mapped through the transform, so the visible
  // world rectangle starts at -translate/scale.
  return {
    left: (-transform.x - margin) / scale,
    top: (-transform.y - margin) / scale,
    right: (viewportWidth - transform.x + margin) / scale,
    bottom: (viewportHeight - transform.y + margin) / scale
  }
}

/**
 * Select the items intersecting the visible rectangle.
 *
 * @param margin screen-space margin around the viewport, in CSS pixels
 */
export function cullItems(
  layout: Pick<LayoutResult, 'items'>,
  transform: Transform,
  viewportWidth: number,
  viewportHeight: number,
  margin = CULL_MARGIN,
  maxTiles = MAX_MOUNTED_TILES
): CullResult {
  const rect = worldRect(transform, viewportWidth, viewportHeight, margin)
  // A wall with nothing at 60fps is not worth optimising for; a zero-size
  // viewport (first paint, or a hidden window) must still return something sane.
  if (!(viewportWidth > 0) || !(viewportHeight > 0)) {
    return { items: layout.items.slice(0, maxTiles), ids: new Set(layout.items.slice(0, maxTiles).map((i) => i.id)) }
  }

  const visible: LayoutItem[] = []
  for (const item of layout.items) {
    if (item.x + item.w < rect.left || item.x > rect.right) continue
    if (item.y + item.h < rect.top || item.y > rect.bottom) continue
    visible.push(item)
  }

  if (visible.length <= maxTiles) {
    return { items: visible, ids: new Set(visible.map((item) => item.id)) }
  }

  // Too many: keep the ones closest to the viewport centre.
  const centreX = (rect.left + rect.right) / 2
  const centreY = (rect.top + rect.bottom) / 2
  const distance = (item: LayoutItem): number =>
    Math.hypot(item.x + item.w / 2 - centreX, item.y + item.h / 2 - centreY)

  const nearest = visible
    .map((item) => ({ item, d: distance(item) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, maxTiles)
    .map((entry) => entry.item)

  // Restore layout order so the DOM does not reshuffle on every pan.
  const order = new Map(layout.items.map((item, index) => [item.id, index]))
  nearest.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))

  return { items: nearest, ids: new Set(nearest.map((item) => item.id)) }
}
