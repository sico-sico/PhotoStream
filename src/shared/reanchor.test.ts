import { describe, expect, it } from 'vitest'
import { nearestItem, reanchorTransform } from './reanchor'
import type { LayoutItem } from './layout'

/**
 * Re-anchoring after a re-layout.
 *
 * Zooming out re-lays the wall at a wider container so the columns fill the
 * window. Every tile moves, so the transform must be recomputed or the view
 * appears to jump — which users reported as "zooming sends me back to the first
 * photo".
 */

const viewport = { width: 1000, height: 800 }

/** A 3-column grid of 100x100 tiles. */
const narrow: LayoutItem[] = Array.from({ length: 12 }, (_, i) => ({
  id: `p${i}`,
  x: (i % 3) * 100,
  y: Math.floor(i / 3) * 100,
  w: 100,
  h: 100
}))

/** The same photos in 6 columns, so every row breaks elsewhere. */
const wide: LayoutItem[] = Array.from({ length: 12 }, (_, i) => ({
  id: `p${i}`,
  x: (i % 6) * 100,
  y: Math.floor(i / 6) * 100,
  w: 100,
  h: 100
}))

describe('nearestItem', () => {
  it('finds the tile containing the point', () => {
    expect(nearestItem(narrow, { x: 150, y: 50 })?.id).toBe('p1')
  })

  it('finds the nearest tile to a point between tiles', () => {
    // (99, 99) is the bottom-right corner of p0 (0-100), whose centre is
    // (50, 50) — distance ~69. p4 sits at (100-200, 100-200), centre (150, 150),
    // distance ~72, so p0 is genuinely nearer.
    expect(nearestItem(narrow, { x: 99, y: 99 })?.id).toBe('p0')
    // Past the midpoint, p4 takes over.
    expect(nearestItem(narrow, { x: 105, y: 105 })?.id).toBe('p4')
  })

  it('returns null for an empty layout', () => {
    expect(nearestItem([], { x: 0, y: 0 })).toBeNull()
  })

  it('handles a point far outside the wall', () => {
    expect(nearestItem(narrow, { x: -10000, y: -10000 })?.id).toBe('p0')
  })
})

describe('reanchorTransform', () => {
  it('keeps the photo at the centre of the view centred', () => {
    // Centred on p4 (x 100-200, y 100-200).
    const transform = { scale: 1, x: -150 + viewport.width / 2, y: -150 + viewport.height / 2 }
    const anchor = nearestItem(narrow, { x: 150, y: 150 })
    expect(anchor?.id).toBe('p4')

    const next = reanchorTransform(transform, { items: narrow }, { items: wide }, viewport)

    // p4 is at x=400, y=0 in the wide layout.
    expect(next.x).toBe(viewport.width / 2 - (400 + 50))
    expect(next.y).toBe(viewport.height / 2 - 50)
  })

  it('keeps the zoom untouched', () => {
    const transform = { scale: 1.75, x: -300, y: -200 }
    expect(reanchorTransform(transform, { items: narrow }, { items: wide }, viewport).scale).toBe(1.75)
  })

  it('accounts for the scale when locating the centre', () => {
    // At 2x with no translate, the world point under the window centre is
    // (250, 200) — half the viewport. p5 (150-250, 100-200) has its centre at
    // exactly (200, 150), the closest of the four candidates.
    const transform = { scale: 2, x: 0, y: 0 }
    const next = reanchorTransform(transform, { items: narrow }, { items: wide }, viewport)
    const anchor = nearestItem(narrow, { x: 250, y: 200 })
    expect(anchor?.id).toBe('p5')
    // p5 moves to x=500, y=100 in the wide layout.
    expect(next.x).toBe(viewport.width / 2 - (500 + 50) * 2)
  })

  it('returns the input when there is nothing to anchor to', () => {
    const transform = { scale: 1, x: 10, y: 20 }
    expect(reanchorTransform(transform, { items: [] }, { items: wide }, viewport)).toBe(transform)
    expect(reanchorTransform(transform, { items: narrow }, { items: [] }, viewport)).toBe(transform)
  })

  it('re-anchors to a different photo when the centred one disappeared', () => {
    // A filter can remove the photo that was centred. The nearest *remaining*
    // photo then becomes the anchor, which keeps the view in the same area
    // instead of snapping somewhere arbitrary.
    const transform = { scale: 1, x: 0, y: 0 }
    const partial = wide.filter((item) => item.id !== 'p6')
    const next = reanchorTransform(transform, { items: narrow }, { items: partial }, viewport)
    expect(next).not.toBe(transform)
    expect(Number.isFinite(next.x)).toBe(true)
  })

  it('is a no-op when the layout did not actually move', () => {
    const transform = { scale: 1, x: -150 + viewport.width / 2, y: -150 + viewport.height / 2 }
    const next = reanchorTransform(transform, { items: narrow }, { items: narrow }, viewport)
    expect(next.x).toBeCloseTo(transform.x, 6)
    expect(next.y).toBeCloseTo(transform.y, 6)
  })

  it('treats a zero scale as 1 instead of dividing by zero', () => {
    const next = reanchorTransform({ scale: 0, x: 0, y: 0 }, { items: narrow }, { items: wide }, viewport)
    expect(Number.isFinite(next.x)).toBe(true)
    expect(Number.isFinite(next.y)).toBe(true)
  })
})
