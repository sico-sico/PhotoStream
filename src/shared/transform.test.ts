import { describe, expect, it } from 'vitest'
import {
  IDENTITY,
  MAX_SCALE,
  MIN_FIT_SCALE,
  MIN_SCALE,
  bucketScale,
  clampScale,
  clampViewerTransform,
  containSize,
  fitTransform,
  fitWallTransform,
  minScaleForWall,
  normalizeRotation,
  panBy,
  rotatedSize,
  screenToWorld,
  snapToDevicePixel,
  transformsEqual,
  viewerFitScale,
  visibleWorldRect,
  worldToScreen,
  zoomAt,
  zoomByWheel,
  zoomViewerAbout
} from './transform'

describe('bucketScale', () => {
  it('leaves exactly-on-ladder values alone', () => {
    const step = 1.05
    for (const exponent of [-6, -3, 0, 3, 6]) {
      const value = step ** exponent
      expect(bucketScale(value, step)).toBeCloseTo(value, 10)
    }
  })

  it('snaps to the nearest rung, up or down', () => {
    const step = 1.05
    const rung = step ** -4
    // Just above and just below a rung both come back to it; both sides are
    // within half a step, and a step is 5%.
    expect(bucketScale(rung * 1.01, step)).toBeCloseTo(rung, 10)
    expect(bucketScale(rung * 0.99, step)).toBeCloseTo(rung, 10)
  })

  it('is never more than half a step away', () => {
    const step = 1.05
    for (let scale = 0.05; scale <= 1; scale *= 1.013) {
      const bucketed = bucketScale(scale, step)
      expect(Math.abs(Math.log(bucketed / scale))).toBeLessThanOrEqual(Math.log(step) / 2 + 1e-9)
    }
  })

  it('collapses a continuous gesture into far fewer values', () => {
    // A pinch from 1 to 0.3 in 60 equal steps would re-flow the wall 60 times
    // unrounded; bucketing has to bring that down substantially.
    const scales = Array.from({ length: 60 }, (_, i) => 1 * (0.3 / 1) ** (i / 59))
    const distinct = new Set(scales.map((scale) => bucketScale(scale).toFixed(6)))
    expect(distinct.size).toBeLessThan(scales.length / 2)
  })

  it('is monotonic, so zooming out never appears to zoom back in', () => {
    let previous = 0
    for (let scale = 0.05; scale <= 2; scale *= 1.01) {
      const bucketed = bucketScale(scale)
      expect(bucketed).toBeGreaterThanOrEqual(previous)
      previous = bucketed
    }
  })

  it('passes through values it cannot bucket', () => {
    // A caller feeding a zero or NaN must not get a broken width out of it.
    expect(bucketScale(0)).toBe(0)
    expect(bucketScale(-1)).toBe(-1)
    expect(Number.isNaN(bucketScale(Number.NaN))).toBe(true)
    expect(bucketScale(0.5, 1)).toBe(0.5)
  })
})

describe('minScaleForWall', () => {
  it('is the scale at which the wall area exactly covers the window', () => {
    // area * s^2 = windowArea  =>  s = sqrt(windowArea / wallArea)
    const floor = minScaleForWall(1600, 140230, 1600, 956)
    expect(floor * floor * (1600 * 140230)).toBeCloseTo(1600 * 956, 2)
  })

  it('never drops below the generic minimum', () => {
    // A wall far larger than the window needs a floor well above `MIN_SCALE`; the
    // generic minimum is only the lower bound of that formula.
    expect(minScaleForWall(1600, 140230, 1600, 956)).toBeGreaterThan(MIN_SCALE)
    // An empty wall falls back to it.
    expect(minScaleForWall(0, 0, 1600, 956)).toBe(MIN_SCALE)
  })

  it('never exceeds 1, so a small wall can still be zoomed out', () => {
    // Returning more than 1 would forbid zooming out on a small library and
    // would break `fitToView`, which legitimately scales below 1.
    expect(minScaleForWall(1600, 2000, 1600, 956)).toBeLessThanOrEqual(1)
    expect(minScaleForWall(10, 10, 1600, 956)).toBeLessThanOrEqual(1)
  })

  it('is higher for a taller wall, which covers more area per scaled pixel', () => {
    const tall = minScaleForWall(1600, 200_000, 1600, 956)
    const short = minScaleForWall(1600, 20_000, 1600, 956)
    expect(tall).toBeLessThan(short)
  })

  it('falls back to the generic minimum for unknown geometry', () => {
    // Before the first layout, dimensions are zero; a nonsense floor would pin
    // the wall and make the wheel appear dead.
    expect(minScaleForWall(0, 0, 1600, 956)).toBe(MIN_SCALE)
    expect(minScaleForWall(1600, 0, 1600, 956)).toBe(MIN_SCALE)
    expect(minScaleForWall(1600, 1000, 0, 0)).toBe(MIN_SCALE)
  })
})

describe('screen/world conversion', () => {  const t = { scale: 2, x: 100, y: 50 }

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

describe('containSize', () => {
  it('letterboxes a wide photo into a square box', () => {
    // 3:2 into 500x500 leaves horizontal bars, not a stretched photo.
    expect(containSize(3000, 2000, 500, 500)).toEqual({ width: 500, height: 500 * (2000 / 3000) })
  })

  it('pillarboxes a tall photo', () => {
    const box = containSize(1000, 2000, 600, 600)
    expect(box.width).toBe(300)
    expect(box.height).toBe(600)
  })

  it('never exceeds either side of the box', () => {
    const box = containSize(2400, 1600, 1552, 920)
    expect(box.width).toBeLessThanOrEqual(1552)
    expect(box.height).toBeLessThanOrEqual(920)
    // One axis is the limiting one, so it must be exactly filled.
    expect(Math.max(box.width, box.height)).toBeGreaterThan(0)
    expect(box.height).toBeCloseTo(920, 6)
  })

  it('reports the photo smaller than its element box', () => {
    // This is the bug that made the viewer shrink a fitted photo: the `<img>`
    // element was 1552x1035 while `object-fit` drew it at 1416x944.
    const box = containSize(2400, 1600, 1552, 920)
    expect(box.width).toBeLessThan(1552)
    expect(box.height).toBeLessThanOrEqual(920)
  })

  it('returns an empty size for a degenerate input', () => {
    expect(containSize(0, 100, 500, 500)).toEqual({ width: 0, height: 0 })
    expect(containSize(100, 0, 500, 500)).toEqual({ width: 0, height: 0 })
    expect(containSize(100, 100, 0, 500)).toEqual({ width: 0, height: 0 })
    expect(containSize(100, 100, 500, -1)).toEqual({ width: 0, height: 0 })
  })
})

describe('normalizeRotation', () => {
  it('snaps to the nearest quarter turn', () => {
    expect(normalizeRotation(90)).toBe(90)
    expect(normalizeRotation(360)).toBe(0)
    expect(normalizeRotation(450)).toBe(90)
    expect(normalizeRotation(180)).toBe(180)
  })

  it('keeps a left turn negative instead of wrapping to 270', () => {
    // The toolbar label shows the angle; "-90°" reads as a left turn, "270°"
    // does not.
    expect(normalizeRotation(-90)).toBe(-90)
    expect(normalizeRotation(-450)).toBe(-90)
    expect(normalizeRotation(270)).toBe(-90)
  })

  it('rounds an arbitrary angle to the nearest quarter turn', () => {
    // Rotating by a hand-drawn angle would leave the bounds computed for a box
    // the photo does not occupy.
    expect(normalizeRotation(44)).toBe(0)
    expect(normalizeRotation(46)).toBe(90)
    expect(normalizeRotation(-44)).toBe(0)
  })

  it('falls back to upright for a non-finite angle', () => {
    expect(normalizeRotation(Number.NaN)).toBe(0)
    expect(normalizeRotation(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('rotatedSize', () => {
  it('leaves an unrotated box alone', () => {
    expect(rotatedSize(400, 300, 0)).toEqual({ width: 400, height: 300 })
  })

  it('swaps the axes at a quarter turn', () => {
    expect(rotatedSize(400, 300, 90)).toEqual({ width: 300, height: 400 })
    expect(rotatedSize(400, 300, 270)).toEqual({ width: 300, height: 400 })
  })

  it('is exact at half turns despite floating point cosine', () => {
    // Math.cos(Math.PI) is -1 but Math.cos(90 * PI / 180) is 6.1e-17, which
    // would leave a sub-pixel sliver of gap at the stage edge.
    expect(rotatedSize(400, 300, 180)).toEqual({ width: 400, height: 300 })
    expect(rotatedSize(400, 300, 90).height).toBe(400)
  })

  it('grows a square by up to the diagonal at 45 degrees', () => {
    const box = rotatedSize(100, 100, 45)
    expect(box.width).toBeCloseTo(141.42, 2)
    expect(box.height).toBeCloseTo(141.42, 2)
  })

  it('treats a degenerate box as empty', () => {
    expect(rotatedSize(0, 100, 90)).toEqual({ width: 0, height: 0 })
    expect(rotatedSize(100, -5, 90)).toEqual({ width: 0, height: 0 })
  })
})

describe('viewerFitScale', () => {
  const stage = { viewportWidth: 1000, viewportHeight: 800 }

  it('needs no shrink when the photo already fits', () => {
    expect(viewerFitScale({ ...stage, imageWidth: 640, imageHeight: 480, rotation: 0 })).toBe(1)
  })

  it('shrinks a portrait photo turned landscape out of a tall stage', () => {
    // 400x700 upright fits 800px of height; rotated it is 700x400 and fits too,
    // so a rotation that still fits must not shrink the photo.
    expect(viewerFitScale({ ...stage, imageWidth: 400, imageHeight: 700, rotation: 90 })).toBe(1)
  })

  it('shrinks when the rotated box no longer fits the stage', () => {
    // A 990x790 photo fits; rotated it is 790x990 and overflows the 800px height.
    const scale = viewerFitScale({ ...stage, imageWidth: 990, imageHeight: 790, rotation: 90 })
    expect(scale).toBeLessThan(1)
    expect(scale).toBeCloseTo(800 / 990, 5)
  })

  it('never scales a rotated photo up', () => {
    // Rotating must not silently zoom: that would leave the user wondering why
    // an orientation control changed the magnification.
    expect(viewerFitScale({ ...stage, imageWidth: 100, imageHeight: 100, rotation: 90 })).toBe(1)
  })

  it('returns 1 for a degenerate stage', () => {
    expect(viewerFitScale({ ...stage, imageWidth: 0, imageHeight: 0, rotation: 90 })).toBe(1)
    expect(viewerFitScale({ viewportWidth: 0, viewportHeight: 0, imageWidth: 400, imageHeight: 300, rotation: 90 })).toBe(1)
  })
})

describe('clampViewerTransform', () => {
  // A photo that fills the stage when upright, so the numbers stay readable.
  const geometry = {
    viewportWidth: 1000,
    viewportHeight: 800,
    imageWidth: 1000,
    imageHeight: 800,
    rotation: 0,
    minZoom: 1,
    maxZoom: 8
  }

  it('leaves a fitted photo untouched', () => {
    const t = { scale: 1, x: 0, y: 0 }
    expect(clampViewerTransform(t, geometry)).toEqual(t)
  })

  it('bounds the zoom to the fit scale and the maximum factor', () => {
    expect(clampViewerTransform({ scale: 0.2, x: 0, y: 0 }, geometry).scale).toBe(1)
    expect(clampViewerTransform({ scale: 999, x: 0, y: 0 }, geometry).scale).toBe(8)
  })

  it('never shrinks below the fit scale', () => {
    // "Fit" is the zoomed-out limit: the whole photo is already visible.
    expect(clampViewerTransform({ scale: 0.4, x: 0, y: 0 }, { ...geometry, minZoom: 2 }).scale).toBe(2)
  })

  it('centres a photo that is smaller than the stage on both axes', () => {
    // At fit the photo exactly fills the stage, so no offset is allowed at all.
    const t = clampViewerTransform({ scale: 1, x: 400, y: 300 }, geometry)
    expect(t.x).toBe(0)
    expect(t.y).toBe(0)
  })

  it('allows panning up to the edge of a zoomed photo, never past it', () => {
    // At 2x the photo is 2000x1600; the stage shows 1000x800 of it, so the
    // centre may move by (2000-1000)/2 = 500 horizontally.
    expect(clampViewerTransform({ scale: 2, x: 9999, y: 0 }, geometry).x).toBe(500)
    expect(clampViewerTransform({ scale: 2, x: -9999, y: 0 }, geometry).x).toBe(-500)
    expect(clampViewerTransform({ scale: 2, x: 0, y: 9999 }, geometry).y).toBe(400)
  })

  it('clamps both axes independently', () => {
    const t = clampViewerTransform({ scale: 2, x: 9999, y: -9999 }, geometry)
    expect(t.x).toBe(500)
    expect(t.y).toBe(-400)
  })

  it('uses the rotated box, so a quarter turn re-opens the vertical range', () => {
    // Upright the photo is 1000x800. Rotated it is 800x1000, which no longer
    // fits the 800px-tall stage, so it is first shrunk by 800/1000 = 0.8. At 2x
    // the box is 1280x1600, leaving (1280-1000)/2 = 140 and (1600-800)/2 = 400
    // of slack: the narrower photo pans less sideways but much further down.
    const rotated = clampViewerTransform({ scale: 2, x: 9999, y: 9999 }, { ...geometry, rotation: 90 })
    expect(rotated.x).toBe(140)
    expect(rotated.y).toBe(400)
  })

  it('accounts for a rotation that needs the photo shrunk to fit', () => {
    // A 990x790 photo fitted upright; rotated it must be scaled down to 800/990
    // first, otherwise the clamp would allow a gap the stage cannot cover.
    const t = clampViewerTransform(
      { scale: 2, x: 9999, y: 0 },
      { ...geometry, imageWidth: 990, imageHeight: 790, rotation: 90 }
    )
    const boxWidth = 790 * (800 / 990) * 2
    expect(t.x).toBeCloseTo((boxWidth - 1000) / 2, 5)
  })

  it('returns the input for a degenerate stage', () => {
    const t = { scale: 2, x: 10, y: 10 }
    expect(clampViewerTransform(t, { ...geometry, viewportWidth: 0, viewportHeight: 0 })).toBe(t)
  })

  it('only bounds the scale while the image size is still unknown', () => {
    // Before the photo decodes there is no box to clamp against, but an
    // unbounded scale would make the first wheel event jump.
    const t = clampViewerTransform({ scale: 99, x: 5, y: 5 }, { ...geometry, imageWidth: 0, imageHeight: 0 })
    expect(t.scale).toBe(8)
    expect(t.x).toBe(5)
  })
})

describe('zoomViewerAbout', () => {
  it('keeps the pivot point pinned', () => {
    // A point 200px right of centre stays 400px right at 2x.
    const t = zoomViewerAbout({ scale: 1, x: 0, y: 0 }, 2, 200, 0, 1, 8)
    expect(t.scale).toBe(2)
    expect(t.x).toBe(-200)
    // Under the same screen point: 200 = 2 * worldX + (-200) => worldX = 200.
    expect((200 - t.x) / t.scale).toBeCloseTo(200, 10)
  })

  it('is a no-op when the scale does not change', () => {
    const t = { scale: 2, x: 30, y: 40 }
    expect(zoomViewerAbout(t, 2, 100, 100, 1, 8)).toEqual(t)
  })

  it('clamps the result to the bounds before solving the offset', () => {
    const t = zoomViewerAbout({ scale: 1, x: 0, y: 0 }, 100, 100, 0, 1, 4)
    expect(t.scale).toBe(4)
  })

  it('survives a zero starting scale', () => {
    const t = zoomViewerAbout({ scale: 0, x: 0, y: 0 }, 2, 0, 0, 1, 8)
    expect(t.scale).toBe(2)
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

describe('snapToDevicePixel', () => {
  it('rounds a CSS size onto whole device pixels', () => {
    // 1227.385 CSS px at 150% scaling is 1841.078 device px, the case that made
    // a 1:1 photo look resampled.
    expect(snapToDevicePixel(1227.385, 1.5) * 1.5).toBeCloseTo(1841, 10)
    expect(snapToDevicePixel(666.6667, 1)).toBe(667)
    expect(snapToDevicePixel(1000, 1.5)).toBe(1000)
  })

  it('leaves values alone when there is nothing to snap', () => {
    // A nonsensical ratio must not divide by zero or return NaN.
    expect(snapToDevicePixel(12.3, 0)).toBe(12.3)
    expect(snapToDevicePixel(12.3, -2)).toBe(12.3)
    expect(snapToDevicePixel(Number.NaN, 1.5)).toBeNaN()
    expect(snapToDevicePixel(Number.POSITIVE_INFINITY, 1.5)).toBe(Number.POSITIVE_INFINITY)
  })

  it('never moves a value by more than half a device pixel', () => {
    for (const dpr of [1, 1.25, 1.5, 2, 3]) {
      for (const value of [0.3, 17.77, 666.6667, 1227.385, 8063.97]) {
        expect(Math.abs(snapToDevicePixel(value, dpr) - value) * dpr).toBeLessThanOrEqual(0.5 + 1e-9)
      }
    }
  })
})
