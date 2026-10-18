import { describe, expect, it } from 'vitest'
import { VIEWER_MAX_ZOOM, VIEWER_MIN_CEILING, VIEWER_MIN_ZOOM, viewerMaxZoom } from './transform'

/**
 * The viewer's zoom ceiling.
 *
 * Zooming past 1:1 stretches pixels without revealing detail, so the ceiling is
 * derived from the photo's real resolution. A small image must not be blown up
 * into mush, and a large one must be inspectable at full resolution.
 */
describe('viewerMaxZoom', () => {
  it('allows exactly the ratio between source and displayed pixels', () => {
    // A 6000px photo shown 1552px wide can be magnified 3.87x before 1:1.
    expect(viewerMaxZoom(6000, 1552)).toBeCloseTo(3.87, 2)
  })

  it('floors the ratio at the useful ceiling', () => {
    // 2592px shown at 1552px is 1.67:1, below the floor, so the viewer offers 2x.
    expect(viewerMaxZoom(2592, 1552)).toBe(VIEWER_MIN_CEILING)
  })

  it('allows a large photo to be magnified more', () => {
    // A 7952px photo shown 1600px wide: nearly 5x before hitting 1:1.
    expect(viewerMaxZoom(7952, 1600)).toBeCloseTo(4.97, 2)
  })

  it('never goes below the useful ceiling for a small photo', () => {
    // A 200px photo fitted into 1000px computes 0.2:1, which would lock the
    // viewer at "fit" with no way to zoom in at all. A little magnification is
    // more useful than a dead control.
    expect(viewerMaxZoom(200, 1000)).toBe(VIEWER_MIN_CEILING)
  })

  it('still allows zooming when the photo is already 1:1', () => {
    // The test fixtures are 320px wide and land at exactly 320px on screen.
    expect(viewerMaxZoom(320, 320)).toBeGreaterThan(VIEWER_MIN_ZOOM)
  })

  it('never exceeds the hard cap', () => {
    expect(viewerMaxZoom(100000, 100)).toBe(VIEWER_MAX_ZOOM)
  })

  it('halves the allowance on a 2x display', () => {
    // On a retina screen the same image occupies twice the device pixels, so
    // 1:1 is reached at half the CSS-pixel magnification.
    expect(viewerMaxZoom(8000, 1000, 1)).toBe(8)
    expect(viewerMaxZoom(8000, 1000, 2)).toBe(4)
  })

  it('falls back to the hard cap for unknown dimensions', () => {
    // Loading has not happened yet, so any answer is provisional; being able to
    // zoom at all is better than locking the control.
    expect(viewerMaxZoom(0, 1000)).toBe(VIEWER_MAX_ZOOM)
    expect(viewerMaxZoom(1000, 0)).toBe(VIEWER_MAX_ZOOM)
    expect(viewerMaxZoom(Number.NaN, 1000)).toBe(VIEWER_MAX_ZOOM)
    expect(viewerMaxZoom(1000, 500, 0)).toBe(VIEWER_MAX_ZOOM)
  })
})
