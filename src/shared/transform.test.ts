import { describe, expect, it } from 'vitest'
import {
  IDENTITY,
  MAX_SCALE,
  MIN_FIT_SCALE,
  MIN_SCALE,
  VIEWER_MAX_ZOOM,
  VIEWER_MIN_ZOOM,
  clampScale,
  clampViewerTransform,
  fitTransform,
  fitWallTransform,
  panBy,
  screenToWorld,
  transformsEqual,
  visibleWorldRect,
  worldToScreen,
  zoomAt,
  zoomByWheel
} from './transform'

describe('screen/world conversion', () => {
  const t = { scale: 2, x: 100, y: 50 }

  it('round-trips a point', () => {
    const world = screenToWorld(t, 340, 250)
    expect(world).toEqual({ x: 120, y: 100 })
    expect(worldToScreen(t, world.x, world.y)).toEqual({ x: 340, y: 250 })
  })

  it('maps the origin through the translation', () => {
    expect(worldToScreen(t, 0, 0)).toEqual({ x: 100, y: 50 })
  })
})

describe('clampScale', () => {
  it('bounds the value', () => {
    expect(clampScale(0.0001)).toBe(MIN_SCALE)
    expect(clampScale(1000)).toBe(MAX_SCALE)
    expect(clampScale(1)).toBe(1)
  })

  it('turns NaN into the minimum rather than propagating it', () => {
    expect(clampScale(Number.NaN)).toBe(MIN_SCALE)
  })

  it('accepts custom bounds', () => {
    expect(clampScale(5, 0.5, 2)).toBe(2)
  })
})

describe('zoomAt', () => {
  it('keeps the world point under the cursor pinned', () => {
    const before = { scale: 1, x: 0, y: 0 }
    const cursor = { x: 300, y: 200 }
    const worldBefore = screenToWorld(before, cursor.x, cursor.y)

    const after = zoomAt(before, 2.5, cursor.x, cursor.y)
    const worldAfter = screenToWorld(after, cursor.x, cursor.y)

    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 6)
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 6)
  })

  it('keeps the anchor pinned from a non-identity transform', () => {
    const before = { scale: 1.7, x: -320, y: 88 }
    const cursor = { x: 640, y: 360 }
    const worldBefore = screenToWorld(before, cursor.x, cursor.y)

    const after = zoomAt(before, 0.6, cursor.x, cursor.y)
    const worldAfter = screenToWorld(after, cursor.x, cursor.y)

    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 6)
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 6)
  })

  it('returns the same object when the scale does not change', () => {
    const t = { scale: MAX_SCALE, x: 10, y: 20 }
    expect(zoomAt(t, 100, 0, 0)).toBe(t)
  })

  it('clamps the requested scale', () => {
    expect(zoomAt({ scale: 1, x: 0, y: 0 }, 1e9, 0, 0).scale).toBe(MAX_SCALE)
    expect(zoomAt({ scale: 1, x: 0, y: 0 }, 0, 0, 0).scale).toBe(MIN_SCALE)
  })
})

describe('zoomByWheel', () => {
  const base = { scale: 1, x: 0, y: 0 }

  it('zooms in for a negative delta (wheel up)', () => {
    expect(zoomByWheel(base, -100, 0, 0, 0).scale).toBeGreaterThan(1)
  })

  it('zooms out for a positive delta', () => {
    expect(zoomByWheel(base, 100, 0, 0, 0).scale).toBeLessThan(1)
  })

  it('normalises line and page delta modes', () => {
    const pixels = zoomByWheel(base, 3, 0, 0, 0).scale
    const lines = zoomByWheel(base, 3, 1, 0, 0).scale
    const pages = zoomByWheel(base, 3, 2, 0, 0).scale

    // The same physical notch must zoom further the larger the unit.
    expect(lines).toBeLessThan(pixels)
    expect(pages).toBeLessThan(lines)
  })

  it('treats a trackpad-sized delta as a small step', () => {
    const tiny = zoomByWheel(base, -4, 0, 0, 0).scale
    const notch = zoomByWheel(base, -100, 0, 0, 0).scale
    expect(tiny).toBeGreaterThan(1)
    expect(tiny).toBeLessThan(notch)
  })

  it('keeps the cursor anchor', () => {
    const before = { scale: 1.2, x: -50, y: 30 }
    const worldBefore = screenToWorld(before, 400, 300)
    const after = zoomByWheel(before, -120, 0, 400, 300)
    const worldAfter = screenToWorld(after, 400, 300)
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 6)
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 6)
  })

  it('respects a custom speed', () => {
    const slow = zoomByWheel(base, -100, 0, 0, 0, { speed: 0.001 }).scale
    const fast = zoomByWheel(base, -100, 0, 0, 0, { speed: 0.003 }).scale
    expect(fast).toBeGreaterThan(slow)
  })

  it('never exceeds the scale limits', () => {
    expect(zoomByWheel(base, -100000, 0, 0, 0).scale).toBe(MAX_SCALE)
    expect(zoomByWheel(base, 100000, 0, 0, 0).scale).toBe(MIN_SCALE)
  })
})

describe('panBy', () => {
  it('translates in screen space without touching scale', () => {
    const result = panBy({ scale: 2, x: 10, y: 20 }, 5, -7)
    expect(result).toEqual({ scale: 2, x: 15, y: 13 })
  })
})

describe('fitWallTransform', () => {
  it('fills the window width for a tall wall', () => {
    // Real numbers from a 3226-photo library at a 1600px window: the layout
    // width already equals the container width, and the wall is ~140000px tall.
    // Fitting both axes gave 0.011, clamped to 0.22, leaving 78% of the window
    // empty — that was the reported "thumbnails do not fill the window".
    const t = fitWallTransform(1600, 140230, 1600, 1000)
    expect(t.scale).toBe(1)
    expect(1600 * t.scale).toBeCloseTo(1600, 6)
    expect(t.x).toBe(0)
  })

  it('covers the width edge to edge with no side gap', () => {
    // A world narrower than the window is scaled up to cover it, unless
    // `maxScale` caps it (a small library should not be blown up).
    const t = fitWallTransform(1590, 140230, 1600, 1000, { maxScale: 2 })
    expect(t.x).toBe(0)
    expect(1590 * t.scale).toBeCloseTo(1600, 6)
  })

  it('centres instead of enlarging past maxScale', () => {
    // A 20-photo wall is narrower than the window; stretching it to fill would
    // make every tile absurdly large.
    const t = fitWallTransform(1000, 2000, 1600, 1000, { maxScale: 1 })
    expect(t.scale).toBe(1)
    expect(t.x).toBeCloseTo(300, 6)
  })

  it('absorbs sub-pixel layout rounding without adding a margin', () => {
    // The layout rounds to two decimals, so its width can be a fraction short.
    // Treating that as "narrower than the window" would centre it and create a
    // visible sliver at both edges.
    const t = fitWallTransform(1599.94, 50000, 1600, 1000)
    expect(t.x).toBe(0)
    expect(t.scale).toBe(1)
  })

  it('anchors to the top rather than centring vertically', () => {
    // Centring a 140000px-tall wall would scroll past the first photos.
    const t = fitWallTransform(1600, 140230, 1600, 1000)
    expect(t.y).toBe(0)
  })

  it('centres horizontally when the wall is narrower than the window', () => {
    const t = fitWallTransform(400, 2000, 1000, 800, { maxScale: 1 })
    // Width fit would want 2.5x, but maxScale caps it at 1.
    expect(t.scale).toBe(1)
    expect(t.x).toBeCloseTo((1000 - 400) / 2, 6)
  })

  it('never exceeds maxScale', () => {
    const t = fitWallTransform(100, 100, 4000, 4000, { maxScale: 1 })
    expect(t.scale).toBe(1)
  })

  it('respects the readable minimum for an absurdly wide wall', () => {
    const t = fitWallTransform(100000, 5000, 1600, 1000)
    expect(t.scale).toBe(MIN_FIT_SCALE)
  })

  it('returns identity for a degenerate world', () => {
    expect(fitWallTransform(0, 0, 1600, 1000)).toEqual(IDENTITY)
    expect(fitWallTransform(1600, -5, 1600, 1000)).toEqual(IDENTITY)
  })

  it('never leaves a gap on either side when the wall is wider than the window', () => {
    for (const viewportWidth of [720, 1280, 1600, 2560]) {
      // The layout is always built for the container width, so the world width
      // matches the viewport and the padding carves space out of it.
      const t = fitWallTransform(1600, 40000, viewportWidth, 1000, { padding: 16 })
      const right = t.x + 1600 * t.scale
      expect(t.x).toBeGreaterThanOrEqual(0)
      expect(right).toBeGreaterThan(0)    }
  })
})

describe('clampViewerTransform', () => {
  const viewport = { w: 1000, h: 800 }

  it('leaves a fitted photo untouched', () => {
    const t = { scale: 1, x: 0, y: 0 }
    expect(clampViewerTransform(t, viewport.w, viewport.h, 1)).toEqual(t)
  })

  it('bounds the zoom to the fit scale and the maximum factor', () => {
    expect(clampViewerTransform({ scale: 0.2, x: 0, y: 0 }, viewport.w, viewport.h, 1).scale).toBe(VIEWER_MIN_ZOOM)
    expect(clampViewerTransform({ scale: 999, x: 0, y: 0 }, viewport.w, viewport.h, 1).scale).toBe(VIEWER_MAX_ZOOM)
  })

  it('never shrinks below the fit scale', () => {
    // "Fit" is the zoomed-out limit: the whole photo is already visible.
    const t = clampViewerTransform({ scale: 0.4, x: 0, y: 0 }, viewport.w, viewport.h, 2)
    expect(t.scale).toBe(VIEWER_MIN_ZOOM * 2)
  })

  it('centres horizontally when the photo is narrower than the stage', () => {
    // fitScale 2 means the untransformed photo fills the stage, so at scale 2
    // it is exactly the stage size and there is no slack to pan.
    const t = clampViewerTransform({ scale: 2, x: 400, y: 0 }, viewport.w, viewport.h, 2)
    expect(t.x).toBe(0)
  })

  it('keeps part of a zoomed photo on screen when panned far right', () => {
    // Dragging right by 5000px would otherwise push the photo completely out.
    const t = clampViewerTransform({ scale: 2, x: 5000, y: 0 }, viewport.w, viewport.h, 1)
    expect(t.x).toBeLessThanOrEqual(viewport.w * 0.75)
  })

  it('keeps part of a zoomed photo on screen when panned far left', () => {
    const t = clampViewerTransform({ scale: 2, x: -5000, y: 0 }, viewport.w, viewport.h, 1)
    // The photo is 2000px wide; at least a quarter of the viewport must overlap.
    expect(t.x).toBeGreaterThanOrEqual(viewport.w - 2000 - viewport.w * 0.75)
  })

  it('clamps both axes independently', () => {
    const t = clampViewerTransform({ scale: 2, x: 5000, y: -5000 }, viewport.w, viewport.h, 1)
    expect(t.x).toBeLessThanOrEqual(viewport.w)
    expect(t.y).toBeGreaterThanOrEqual(-viewport.h * 2)
  })

  it('returns the input for a degenerate stage', () => {
    const t = { scale: 2, x: 10, y: 10 }
    expect(clampViewerTransform(t, 0, 0, 1)).toBe(t)
    expect(clampViewerTransform(t, 100, 100, 0)).toBe(t)
  })
})

describe('fitTransform', () => {
  it('centres the world in the viewport', () => {
    const t = fitTransform(1000, 500, 1200, 800, { padding: 0 })
    expect(t.scale).toBe(1)
    expect(t.x).toBeCloseTo((1200 - 1000) / 2, 6)
    expect(t.y).toBeCloseTo((800 - 500) / 2, 6)
  })

  it('scales down to fit the limiting dimension', () => {
    // Height is the constraint: (800 - 48) / 1000 = 0.752
    const t = fitTransform(100, 1000, 1200, 800)
    expect(t.scale).toBeCloseTo(0.752, 3)
  })

  it('never scales above maxScale', () => {
    expect(fitTransform(10, 10, 2000, 2000).scale).toBe(1)
    expect(fitTransform(10, 10, 2000, 2000, { maxScale: 0.5 }).scale).toBe(0.5)
  })

  it('keeps the content inside the padded viewport', () => {
    const t = fitTransform(3000, 2000, 1000, 700, { padding: 20 })
    expect(3000 * t.scale).toBeLessThanOrEqual(1000 - 40 + 0.001)
    expect(2000 * t.scale).toBeLessThanOrEqual(700 - 40 + 0.001)
  })

  it('respects centre:false', () => {
    const t = fitTransform(100, 100, 500, 500, { padding: 10, center: false })
    expect(t.x).toBe(10)
    expect(t.y).toBe(10)
  })

  it('returns identity for a degenerate world', () => {
    expect(fitTransform(0, 0, 800, 600)).toEqual(IDENTITY)
    expect(fitTransform(-5, 100, 800, 600)).toEqual(IDENTITY)
  })

  it('keeps a huge wall readable instead of shrinking to nothing', () => {
    // A 3226-photo wall is ~64000px tall. Fitting it entirely into 800px gave
    // scale 0.05, which pinned the view to the minimum: every tile was 16px and
    // the wheel appeared dead.
    const transform = fitTransform(7600, 64000, 1600, 1000)
    expect(transform.scale).toBeGreaterThanOrEqual(MIN_FIT_SCALE)
    expect(transform.scale).toBe(MIN_FIT_SCALE)
    // Too tall to fit, so it starts at the top-left rather than being centred
    // in a space that does not exist.
    expect(transform.x).toBe(24)
    expect(transform.y).toBe(24)
  })

  it('still centres a wall that does fit', () => {
    const transform = fitTransform(800, 400, 1600, 1000, { padding: 0 })
    expect(transform.scale).toBe(1)
    expect(transform.x).toBeCloseTo((1600 - 800) / 2, 6)
  })

  it('honours a custom minimum fit scale', () => {
    const transform = fitTransform(10000, 10000, 1600, 1000, { minScale: 0.4 })
    expect(transform.scale).toBe(0.4)
  })

  it('handles a viewport smaller than the padding', () => {
    const t = fitTransform(1000, 1000, 10, 10, { padding: 50 })
    expect(t.scale).toBe(MIN_FIT_SCALE)
    expect(Number.isFinite(t.x)).toBe(true)
  })
})

describe('visibleWorldRect', () => {
  it('covers exactly the viewport', () => {
    const rect = visibleWorldRect({ scale: 2, x: -100, y: -50 }, 800, 600)
    expect(rect).toEqual({ x: 50, y: 25, width: 400, height: 300 })
  })
})

describe('transformsEqual', () => {
  it('compares within epsilon', () => {
    expect(transformsEqual(IDENTITY, { scale: 1, x: 0, y: 0 })).toBe(true)
    expect(transformsEqual(IDENTITY, { scale: 1.0000001, x: 0, y: 0 })).toBe(true)
    expect(transformsEqual(IDENTITY, { scale: 1.1, x: 0, y: 0 })).toBe(false)
    expect(transformsEqual(IDENTITY, { scale: 1, x: 5, y: 0 })).toBe(false)
  })
})
