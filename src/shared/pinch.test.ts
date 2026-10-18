import { describe, expect, it } from 'vitest'
import { MIN_PINCH_DISTANCE, beginPinch, distanceBetween, isPinch, midpoint, pinchScale } from './pinch'

/**
 * Two-finger pinch maths.
 *
 * The gesture is the one place where a single bad frame can blank the photo, so
 * every guard here exists to keep a degenerate pointer pair from turning into a
 * zero or infinite zoom.
 */
describe('distanceBetween', () => {
  it('measures the straight line between two fingers', () => {
    expect(distanceBetween({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
  })

  it('is symmetric', () => {
    const a = { x: 12, y: -7 }
    const b = { x: -30, y: 40 }
    expect(distanceBetween(a, b)).toBe(distanceBetween(b, a))
  })

  it('is zero for coincident fingers', () => {
    expect(distanceBetween({ x: 5, y: 5 }, { x: 5, y: 5 })).toBe(0)
  })
})

describe('midpoint', () => {
  it('finds the centre between two fingers', () => {
    expect(midpoint({ x: 0, y: 0 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 10 })
  })

  it('handles negative coordinates', () => {
    expect(midpoint({ x: -10, y: -20 }, { x: 10, y: 20 })).toEqual({ x: 0, y: 0 })
  })
})

describe('beginPinch', () => {
  it('records the starting spread and midpoint', () => {
    const start = beginPinch({ x: 0, y: 0 }, { x: 100, y: 0 })
    expect(start).toEqual({ distance: 100, midX: 50, midY: 0 })
  })

  it('refuses a pair that is too close to measure', () => {
    // At a few pixels apart, pointer noise dominates the ratio and one frame
    // would fling the zoom across its whole range.
    expect(beginPinch({ x: 0, y: 0 }, { x: 4, y: 0 })).toBeNull()
    expect(beginPinch({ x: 5, y: 5 }, { x: 5, y: 5 })).toBeNull()
  })

  it('accepts a pair exactly at the threshold', () => {
    expect(beginPinch({ x: 0, y: 0 }, { x: MIN_PINCH_DISTANCE, y: 0 })).not.toBeNull()
  })
})

describe('pinchScale', () => {
  const start = beginPinch({ x: 0, y: 0 }, { x: 100, y: 0 })

  it('doubles when the fingers spread to twice the distance', () => {
    expect(pinchScale(start!, { x: -50, y: 0 }, { x: 150, y: 0 })).toBe(2)
  })

  it('returns 1 when the spread is unchanged', () => {
    // Otherwise a pinch that ends where it began would leave the photo zoomed.
    expect(pinchScale(start!, { x: 0, y: 0 }, { x: 100, y: 0 })).toBe(1)
  })

  it('shrinks when the fingers come together', () => {
    expect(pinchScale(start!, { x: 25, y: 0 }, { x: 75, y: 0 })).toBe(0.5)
  })

  it('falls back to 1 for a degenerate frame', () => {
    // A pointer can report 0,0 for one frame while it is being released; a zero
    // ratio would collapse the photo to nothing.
    expect(pinchScale(start!, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(1)
    expect(pinchScale({ distance: 0, midX: 0, midY: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 })).toBe(1)
  })

  it('ignores a non-finite ratio', () => {
    expect(pinchScale(start!, { x: 0, y: 0 }, { x: Number.POSITIVE_INFINITY, y: 0 })).toBe(1)
  })
})

describe('isPinch', () => {
  it('only treats two or more pointers as a pinch', () => {
    expect(isPinch(0)).toBe(false)
    expect(isPinch(1)).toBe(false)
    expect(isPinch(2)).toBe(true)
    expect(isPinch(3)).toBe(true)
  })
})
