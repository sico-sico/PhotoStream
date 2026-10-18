import { describe, expect, it } from 'vitest'
import { MAX_MOUNTED_TILES, PREFETCH_SCREENS, prefetchIdsForScroll } from './cull'
import type { LayoutItem } from './layout'

/**
 * Scrollbar prefetching.
 *
 * Dragging the scrollbar jumps the view by thousands of pixels in one step,
 * which the viewport-driven prefetch cannot anticipate: by the time the new
 * tiles mount, their thumbnails have only just been requested. These tests pin
 * down "the band around the destination", which is what lets the request go out
 * while the jump is still animating.
 */

/**
 * A wall of `count` 100x100 tiles in a 10-column grid, layout order.
 *
 * Tall enough to cover the highest target used below: with 10 columns each row
 * is 100 world pixels, so 2000 tiles give 200 rows.
 */
function grid(count: number, columns = 10): LayoutItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index}`,
    x: (index % columns) * 100,
    y: Math.floor(index / columns) * 100,
    w: 100,
    h: 100
  }))
}

const items = grid(2000)

describe('prefetchIdsForScroll', () => {
  it('returns the rows that will be on screen after the jump', () => {
    // An 800px window over 100px rows shows 8 rows, plus one screen of margin
    // either side.
    const ids = prefetchIdsForScroll({ items }, 800, 1000, 800, 1)
    // Row 8 starts at y=800, which is the target row itself.
    expect(ids).toContain('p80')
    // Far below the window + margin.
    expect(ids).not.toContain('p400')
  })

  it('starts at the target, not at the current view', () => {
    // This is the whole point: prefetching the current view would be useless.
    const ids = prefetchIdsForScroll({ items }, 5000, 1000, 800, 1)
    // Row 41 is the last row that touches the one-screen margin above y=5000.
    expect(ids[0]).toBe('p410')
    expect(ids).not.toContain('p0')
  })

  it('covers whole screens on both sides of the target', () => {
    const ids = prefetchIdsForScroll({ items }, 3000, 1000, 800, 1)
    const rows = ids.map((id) => Number(id.slice(1)) / 10)

    // Target row is 30. The margin is one screen (8 rows) either side, and a
    // row that merely touches the boundary is included, so the band is a little
    // wider than exactly 22..38 plus its overflow.
    expect(Math.min(...rows)).toBeGreaterThanOrEqual(21)
    expect(Math.min(...rows)).toBeLessThanOrEqual(22)
    expect(Math.max(...rows)).toBeGreaterThanOrEqual(46)
    expect(Math.max(...rows)).toBeLessThanOrEqual(47)
  })

  it('scales the band with zoom so it always covers the same amount of screen', () => {
    // At 2x the window covers half as many world rows.
    const zoomedOut = prefetchIdsForScroll({ items }, 3000, 1000, 800, 1)
    const zoomedIn = prefetchIdsForScroll({ items }, 3000, 1000, 800, 2)

    expect(zoomedIn.length).toBeLessThan(zoomedOut.length)
    // The target row is still included either way.
    expect(zoomedIn).toContain('p300')
  })

  it('clamps at the top of the wall', () => {
    const ids = prefetchIdsForScroll({ items }, 0, 1000, 800, 1)
    expect(ids[0]).toBe('p0')
    expect(ids.length).toBeGreaterThan(0)
  })

  it('clamps at the bottom of the wall', () => {
    // Beyond the last row: the band is empty rather than out of range.
    const ids = prefetchIdsForScroll({ items }, 100_000, 1000, 800, 1)
    expect(ids).toEqual([])
  })

  it('returns nothing for an empty wall', () => {
    expect(prefetchIdsForScroll({ items: [] }, 0, 1000, 800, 1)).toEqual([])
  })

  it('returns nothing before the viewport has been measured', () => {
    // The first render reports a zero-size window; asking for a band then would
    // divide by zero.
    expect(prefetchIdsForScroll({ items }, 500, 0, 0, 1)).toEqual([])
  })

  it('treats a non-positive scale as 1 rather than dividing by zero', () => {
    const ids = prefetchIdsForScroll({ items }, 800, 1000, 800, 0)
    expect(ids).toContain('p80')
  })

  it('caps the batch so one jump cannot request the whole library', () => {
    const huge = grid(5000)
    const ids = prefetchIdsForScroll({ items: huge }, 100_000, 1000, 800, 1)
    expect(ids.length).toBeLessThanOrEqual(MAX_MOUNTED_TILES)
  })

  it('honours an explicit limit', () => {
    const ids = prefetchIdsForScroll({ items }, 3000, 1000, 800, 1, 5)
    expect(ids).toHaveLength(5)
  })

  it('keeps layout order, so the nearest rows are requested first', () => {
    const ids = prefetchIdsForScroll({ items }, 3000, 1000, 800, 1)
    const rows = ids.map((id) => Number(id.slice(1)))
    expect([...rows].sort((a, b) => a - b)).toEqual(rows)
  })

  it('exposes the margin as a named constant', () => {
    // One screen either side matches the viewport prefetch's intent without
    // asking for a year of photos.
    expect(PREFETCH_SCREENS).toBe(1)
  })
})
