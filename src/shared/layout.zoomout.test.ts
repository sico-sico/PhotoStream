import { describe, expect, it } from 'vitest'
import { computeLayout } from './layout'
import { minScaleForWall } from './transform'
import type { Photo } from './types'

/**
 * The wall's shape as the user zooms out.
 *
 * Zooming out reflows the wall so the columns keep filling the window: the layout
 * is computed for `viewportWidth / scale` world pixels, which at scale 0.05 is 20x
 * the window. Width is compensated for, height is not 鈥?height follows from the
 * number of photos 鈥?so past some zoom the wall becomes shorter than the window
 * and `clampWallTransform` centres it, leaving empty bands above and below.
 *
 * Measured on the 3226-photo library at scale 0.05: a 32001x6579 world scaled to
 * 1600x329 inside a 1600x956 stage. This pins the geometry that causes it.
 */

/** A library of `count` landscape 3:2 photos. */
function library(count: number): Photo[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `p${i}`,
    path: `/photos/p${i}.jpg`,
    name: `p${i}.jpg`,
    width: 6000,
    height: 4000,
    takenAt: '2020-01-01',
    dateSource: 'exif' as const,
    mtimeMs: 0,
    sizeBytes: 0
  }))
}

const photos = library(3226)

describe('layout at extreme zoom-out', () => {
  it('fills the window horizontally at every zoom, which is why the width is compensated', () => {
    for (const scale of [1, 0.5, 0.25, 0.1, 0.05]) {
      const layoutWidth = Math.round(Math.max(320, 1600) / scale)
      const layout = computeLayout(photos, { mode: 'grid', containerWidth: layoutWidth })
      expect(Math.round(layout.width * scale)).toBeGreaterThanOrEqual(1600 - 2)
    }
  })

  it('becomes shorter than the window below a certain zoom', () => {
    // The defect in numbers: at 0.09 the wall still covers 1045px of a 956px
    // stage, but at 0.05 it covers only 329px.
    const at = (scale: number): number => {
      const layoutWidth = Math.round(1600 / scale)
      const layout = computeLayout(photos, { mode: 'grid', containerWidth: layoutWidth })
      return Math.round(layout.height * scale)
    }

    expect(at(0.09)).toBeGreaterThan(956)
    expect(at(0.05)).toBeLessThan(956)
  })

  it('cannot fill the window below the area-derived scale, whatever the layout', () => {
    // The real defect is geometric, not a layout bug: scaling by `s` covers
    // `area * s虏` screen pixels, so once that is under the window's area nothing
    // can fill it. No widening strategy helps.
    const base = computeLayout(photos, { mode: 'grid', containerWidth: 1600 })
    const floor = minScaleForWall(base.width, base.height, 1600, 956)

    // At and above the floor the wall covers the window vertically.
    for (const scale of [floor, 0.09, 0.15, 0.3]) {
      const layout = computeLayout(photos, { mode: 'grid', containerWidth: Math.round(1600 / scale) })
      expect(Math.round(layout.height * scale)).toBeGreaterThanOrEqual(956)
    }
    // Below it, no layout width can.
    expect(floor).toBeGreaterThan(0.05)
  })
})
