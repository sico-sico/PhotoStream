import { describe, expect, it } from 'vitest'
import {
  KEY_PAN_FRACTION,
  KEY_PAN_LARGE_FRACTION,
  centerOn,
  isComfortablyVisible,
  isPanKey,
  neighbourInDirection,
  panByKey
} from './keyboard'

/**
 * Keyboard navigation.
 *
 * The arrow keys do two different things depending on state (move the selection
 * or pan the canvas), so both halves are checked here rather than through the
 * component.
 */

const viewport = { width: 1000, height: 800 }
const at = (x: number, y: number, scale = 1) => ({ scale, x, y })

describe('isPanKey', () => {
  it('accepts the four arrows', () => {
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) expect(isPanKey(key)).toBe(true)
  })

  it('rejects everything else', () => {
    for (const key of ['a', 'Enter', 'ArrowUpLeft', 'Home', '']) expect(isPanKey(key)).toBe(false)
  })
})

describe('panByKey', () => {
  it('reveals content to the right by moving the wall left', () => {
    // A document scrolls content up under the viewport, and a photo wall should
    // feel the same rather than like dragging a sheet of paper.
    const next = panByKey(at(0, 0), 'ArrowRight', viewport)
    expect(next.x).toBe(-Math.round(viewport.width * KEY_PAN_FRACTION))
    expect(next.y).toBe(0)
  })

  it('moves the wall right on ArrowLeft', () => {
    expect(panByKey(at(0, 0), 'ArrowLeft', viewport).x).toBe(Math.round(viewport.width * KEY_PAN_FRACTION))
  })

  it('moves vertically without touching x', () => {
    expect(panByKey(at(50, 0), 'ArrowDown', viewport)).toEqual({
      scale: 1,
      x: 50,
      y: -Math.round(viewport.height * KEY_PAN_FRACTION)
    })
    expect(panByKey(at(50, 0), 'ArrowUp', viewport)).toEqual({
      scale: 1,
      x: 50,
      y: Math.round(viewport.height * KEY_PAN_FRACTION)
    })
  })

  it('keeps the zoom untouched', () => {
    const next = panByKey(at(0, 0, 2.5), 'ArrowRight', viewport)
    expect(next.scale).toBe(2.5)
  })

  it('takes a much larger step with shift held', () => {
    const normal = panByKey(at(0, 0), 'ArrowRight', viewport)
    const large = panByKey(at(0, 0), 'ArrowRight', viewport, true)
    expect(Math.abs(large.x)).toBeGreaterThan(Math.abs(normal.x))
    expect(Math.abs(large.x)).toBe(Math.round(viewport.width * KEY_PAN_LARGE_FRACTION))
  })

  it('always moves at least one pixel', () => {
    // A 0x0 viewport (first paint) or a very small window must not make the key
    // appear dead.
    expect(panByKey(at(0, 0), 'ArrowRight', { width: 0, height: 0 }).x).toBe(-1)
  })

  it('does not mutate its input', () => {
    const start = at(10, 20)
    panByKey(start, 'ArrowDown', viewport)
    expect(start).toEqual({ scale: 1, x: 10, y: 20 })
  })
})

describe('centerOn', () => {
  it('puts the target in the middle of the viewport', () => {
    const next = centerOn(at(0, 0), { x: 500, y: 400 }, viewport)
    expect(next.x).toBe(0)
    expect(next.y).toBe(0)
  })

  it('accounts for the zoom', () => {
    // At 2x a world point 100px away is 200px on screen, so the offset doubles.
    const next = centerOn(at(0, 0, 2), { x: 100, y: 50 }, viewport)
    expect(next.x).toBe(viewport.width / 2 - 200)
    expect(next.y).toBe(viewport.height / 2 - 100)
  })

  it('keeps the current scale', () => {
    expect(centerOn(at(0, 0, 3), { x: 0, y: 0 }, viewport).scale).toBe(3)
  })
})

describe('isComfortablyVisible', () => {
  it('accepts a point in the middle', () => {
    expect(isComfortablyVisible(at(0, 0), { x: 500, y: 400 }, viewport)).toBe(true)
  })

  it('rejects a point outside the viewport', () => {
    expect(isComfortablyVisible(at(0, 0), { x: 2000, y: 400 }, viewport)).toBe(false)
    expect(isComfortablyVisible(at(0, 0), { x: 500, y: -900 }, viewport)).toBe(false)
  })

  it('rejects a point too close to the edge', () => {
    // 5% from the left edge is inside the viewport but would leave the selected
    // photo visually clipped, so it counts as not comfortably visible.
    expect(isComfortablyVisible(at(0, 0), { x: 50, y: 400 }, viewport)).toBe(false)
    expect(isComfortablyVisible(at(0, 0), { x: 150, y: 400 }, viewport)).toBe(true)
  })

  it('applies the transform when judging', () => {
    // The same world point is off screen once the wall has been panned.
    expect(isComfortablyVisible(at(-2000, 0), { x: 500, y: 400 }, viewport)).toBe(false)
  })
})

/** A 4-column grid of 100x100 tiles, for the neighbour tests. */
const grid = Array.from({ length: 16 }, (_, index) => ({
  id: `p${index}`,
  x: (index % 4) * 100,
  y: Math.floor(index / 4) * 100,
  w: 100,
  h: 100
}))

const tile = (id: string) => grid.find((item) => item.id === id)!

describe('neighbourInDirection', () => {
  it('finds the tile to the right', () => {
    expect(neighbourInDirection(grid, tile('p5'), 'ArrowRight')).toBe('p6')
  })

  it('finds the tile to the left', () => {
    expect(neighbourInDirection(grid, tile('p5'), 'ArrowLeft')).toBe('p4')
  })

  it('finds the tile above', () => {
    expect(neighbourInDirection(grid, tile('p5'), 'ArrowUp')).toBe('p1')
  })

  it('finds the tile below', () => {
    expect(neighbourInDirection(grid, tile('p5'), 'ArrowDown')).toBe('p9')
  })

  it('returns null at the edge instead of wrapping to another row', () => {
    // Wrapping would make the arrow keys feel like a broken list rather than a
    // spatial grid.
    expect(neighbourInDirection(grid, tile('p7'), 'ArrowRight')).toBeNull()
    expect(neighbourInDirection(grid, tile('p4'), 'ArrowLeft')).toBeNull()
    expect(neighbourInDirection(grid, tile('p3'), 'ArrowUp')).toBeNull()
    expect(neighbourInDirection(grid, tile('p15'), 'ArrowDown')).toBeNull()
  })

  it('prefers the tile least off-axis when rows are uneven', () => {
    // A justified row has wider tiles, so the tile straight below may be far
    // horizontally; the nearest by combined distance should win.
    const uneven = [
      { id: 'from', x: 0, y: 0, w: 100, h: 100 },
      { id: 'below-far', x: 400, y: 100, w: 100, h: 100 },
      { id: 'below-near', x: 20, y: 100, w: 100, h: 100 }
    ]
    expect(neighbourInDirection(uneven, uneven[0], 'ArrowDown')).toBe('below-near')
  })

  it('ignores the current tile', () => {
    expect(neighbourInDirection([tile('p5')], tile('p5'), 'ArrowRight')).toBeNull()
  })

  it('handles a single-column wall', () => {
    const column = [
      { id: 'a', x: 0, y: 0, w: 100, h: 100 },
      { id: 'b', x: 0, y: 100, w: 100, h: 100 }
    ]
    expect(neighbourInDirection(column, column[0], 'ArrowDown')).toBe('b')
    expect(neighbourInDirection(column, column[0], 'ArrowRight')).toBeNull()
  })
})
