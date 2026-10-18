import { describe, expect, it } from 'vitest'
import { CULL_MARGIN, MAX_MOUNTED_TILES, cullItems, worldRect } from './cull'
import type { LayoutItem } from './layout'

/**
 * Viewport culling.
 *
 * These tests encode the measurement that motivated the module: with 3226
 * mounted tiles a pan took 27 ms/frame, and with about 200 it took 17 ms. The
 * contract is therefore "mount a few screens' worth, never the whole library".
 */

/** A wall of `count` 100x100 tiles in a 10-column grid with no gaps. */
function grid(count: number, columns = 10): LayoutItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index}`,
    x: (index % columns) * 100,
    y: Math.floor(index / columns) * 100,
    w: 100,
    h: 100
  }))
}

const viewport = { width: 1000, height: 800 }

describe('worldRect', () => {
  it('reports the visible world area at scale 1', () => {
    const rect = worldRect({ scale: 1, x: -200, y: -100 }, viewport.width, viewport.height, 0)
    expect(rect).toEqual({ left: 200, top: 100, right: 1200, bottom: 900 })
  })

  it('divides by the scale', () => {
    // At 2x the same window covers half the world distance.
    const rect = worldRect({ scale: 2, x: 0, y: 0 }, 1000, 800, 0)
    expect(rect.right).toBe(500)
    expect(rect.bottom).toBe(400)
  })

  it('grows by the margin on every side', () => {
    const rect = worldRect({ scale: 1, x: 0, y: 0 }, 1000, 800, 100)
    expect(rect.left).toBe(-100)
    expect(rect.top).toBe(-100)
    expect(rect.right).toBe(1100)
    expect(rect.bottom).toBe(900)
  })

  it('treats a non-positive scale as 1', () => {
    // A zero scale would divide by zero and select every (or no) tile.
    const rect = worldRect({ scale: 0, x: 0, y: 0 }, 1000, 800, 0)
    expect(rect.right).toBe(1000)
  })
})

describe('cullItems', () => {
  it('mounts only what is near the viewport', () => {
    const items = grid(5000)
    const result = cullItems({ items }, { scale: 1, x: 0, y: 0 }, viewport.width, viewport.height)
    expect(result.items.length).toBeGreaterThan(0)
    expect(result.items.length).toBeLessThan(500)
    expect(result.ids.size).toBe(result.items.length)
  })

  it('includes a tile that only touches the viewport edge', () => {
    // A tile starting exactly at the right edge is still partly on screen, so it
    // must be mounted; dropping it would show a gap at the boundary.
    const items = grid(100)
    const result = cullItems({ items }, { scale: 1, x: 0, y: 0 }, 100, 100, 0)
    expect(result.items.map((item) => item.id)).toEqual(['p0', 'p1', 'p10', 'p11'])
  })

  it('excludes tiles past the viewport edge', () => {
    const items = grid(100)
    // Nothing at x >= 200 can be on screen for a 100px-wide window.
    const result = cullItems({ items }, { scale: 1, x: 0, y: 0 }, 100, 100, 0)
    expect(result.items.every((item) => item.x < 200)).toBe(true)
  })

  it('keeps a screen of margin so a fling has content ready', () => {
    const items = grid(100)
    const without = cullItems({ items }, { scale: 1, x: 0, y: 0 }, 100, 100, 0)
    const withMargin = cullItems({ items }, { scale: 1, x: 0, y: 0 }, 100, 100, CULL_MARGIN)
    expect(withMargin.items.length).toBeGreaterThan(without.items.length)
  })

  it('mounts more when zoomed out, but never the whole library', () => {
    const items = grid(5000)
    const zoomedIn = cullItems({ items }, { scale: 4, x: 0, y: 0 }, viewport.width, viewport.height)
    const zoomedOut = cullItems({ items }, { scale: 0.5, x: 0, y: 0 }, viewport.width, viewport.height)
    expect(zoomedOut.items.length).toBeGreaterThan(zoomedIn.items.length)
    expect(zoomedOut.items.length).toBeLessThanOrEqual(MAX_MOUNTED_TILES)
  })

  it('never exceeds the hard cap', () => {
    // A tiny scale over a huge wall would otherwise select thousands of tiles.
    const items = grid(20000)
    const result = cullItems({ items }, { scale: 0.01, x: 0, y: 0 }, viewport.width, viewport.height)
    expect(result.items.length).toBeLessThanOrEqual(MAX_MOUNTED_TILES)
  })

  it('keeps the tiles closest to the viewport centre when the cap applies', () => {
    // A 10x10 wall seen through a tiny window: the cap is far below the tile
    // count, so the survivors must be those nearest the centre of the view.
    const items = grid(100, 10)
    const result = cullItems({ items }, { scale: 1, x: 0, y: 0 }, 1000, 1000, 0, 4)

    expect(result.items).toHaveLength(4)
    // The viewport covers x 0..1000, y 0..1000, centred on (500, 500). The four
    // nearest tiles are the ones around that point.
    const centre = { x: 500, y: 500 }
    const kept = result.items.map((item) => [Math.round(item.x), Math.round(item.y)])
    expect(kept).toEqual(
      expect.arrayContaining([
        [400, 400],
        [400, 500],
        [500, 400],
        [500, 500]
      ])
    )
    // Distant corners are dropped even though they are inside the viewport.
    expect(result.ids.has('p0')).toBe(false)
    void centre
  })

  it('preserves layout order in the mounted set', () => {
    const items = grid(200)
    const result = cullItems({ items }, { scale: 1, x: 0, y: 0 }, viewport.width, viewport.height)
    const order = new Map(items.map((item, index) => [item.id, index]))
    const indices = result.items.map((item) => order.get(item.id) ?? -1)
    expect(indices).toEqual([...indices].sort((a, b) => a - b))
  })

  it('returns everything for a zero-size viewport', () => {
    // The first paint measures 0x0; returning nothing would flash an empty wall.
    const items = grid(5)
    expect(cullItems({ items }, { scale: 1, x: 0, y: 0 }, 0, 0).items).toHaveLength(5)
  })

  it('handles an empty wall', () => {
    expect(cullItems({ items: [] }, { scale: 1, x: 0, y: 0 }, 1000, 800)).toEqual({ items: [], ids: new Set() })
  })

  it('handles a wall far from the viewport', () => {
    const items = grid(100)
    const result = cullItems({ items }, { scale: 1, x: -99999, y: -99999 }, viewport.width, viewport.height)
    expect(result.items).toEqual([])
  })
})
