import { describe, expect, it } from 'vitest'
import { CULL_MARGIN, MAX_MOUNTED_TILES, cullItems } from './cull'
import { computeLayout } from './layout'
import { minScaleForTiles, minScaleForWall } from './transform'
import type { Photo } from './types'

/**
 * The two ways zooming out used to drop photos.
 *
 * Reported as "some images stop showing when zoomed out". Both causes are here:
 *
 * 1. The request band and the mounted set were computed by different rules — one
 *    with `max(viewportWidth, viewportHeight)` as margin and layout order, the
 *    other with a flat 900 px margin and centre-distance truncation. Where the
 *    cap bit, the two sets barely overlapped, so mounted tiles had no image at
 *    all.
 * 2. Zooming out far enough put more tiles on screen than the mount cap allows,
 *    and the surplus was simply not rendered.
 *
 * Measured on the 3226-photo library: 600 of 2332 visible tiles were dropped at
 * scale 0.2271, and every one of the 600 mounted tiles was blank.
 */

const VIEWPORT = { width: 1600, height: 956 }

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

/** The wall as it is laid out at a given zoom. */
function layoutAt(scale: number) {
  return computeLayout(photos, {
    mode: 'grid',
    containerWidth: Math.round(VIEWPORT.width / scale)
  })
}

/** Tiles the cull would mount, i.e. what the thumbnail requests must cover. */
function mountedAt(scale: number): string[] {
  const layout = layoutAt(scale)
  return cullItems(layout, { scale, x: 0, y: 0 }, VIEWPORT.width, VIEWPORT.height).items.map((i) => i.id)
}

/** Tiles on screen, ignoring the cap and the margin. */
function visibleAt(scale: number): number {
  return cullItems(
    layoutAt(scale),
    { scale, x: 0, y: 0 },
    VIEWPORT.width,
    VIEWPORT.height,
    0,
    Number.MAX_SAFE_INTEGER
  ).items.length
}

describe('zoomed-out wall', () => {
  it('would drop photos if the zoom were allowed below the tile floor', () => {
    // The bug, reproduced: the cull mounts with a 900px margin, and at 0.15 that
    // band holds far more than the cap, so the surplus is never mounted and those
    // photos are not on screen at all.
    expect(mountedAt(0.15).length).toBe(MAX_MOUNTED_TILES)
    expect(visibleAt(0.15)).toBeGreaterThan(MAX_MOUNTED_TILES)
  })

  it('keeps the mounted set under the cap at the derived floor', () => {
    const baseLayout = computeLayout(photos, { mode: 'grid', containerWidth: VIEWPORT.width })
    const areaFloor = minScaleForWall(
      baseLayout.width,
      baseLayout.height,
      VIEWPORT.width,
      VIEWPORT.height
    )
    const floor = minScaleForTiles(
      (scale) =>
        cullItems(
          layoutAt(scale),
          { scale, x: 0, y: 0 },
          VIEWPORT.width,
          VIEWPORT.height,
          CULL_MARGIN,
          Number.MAX_SAFE_INTEGER
        ).items.length,
      MAX_MOUNTED_TILES,
      areaFloor
    )

    // At the floor the wall mounts no more than the cap allows, so nothing that
    // is on screen gets dropped.
    expect(mountedAt(floor).length).toBeLessThanOrEqual(MAX_MOUNTED_TILES)
    expect(floor).toBeGreaterThan(0.2)
  })

  it('counts the margin when deriving the floor', () => {
    // Measuring without the margin undercounted by about a third and let the
    // floor through too low, so the cap still bit.
    const withMargin = mountedAt(0.25).length
    const withoutMargin = visibleAt(0.25)
    expect(withMargin).toBeGreaterThan(withoutMargin)
  })

  it('gives a floor that a small library is not constrained by', () => {
    const small = library(12)
    const base = computeLayout(small, { mode: 'grid', containerWidth: VIEWPORT.width })
    const floor = minScaleForTiles(() => 12, MAX_MOUNTED_TILES, 0.05)
    expect(floor).toBe(0.05)
    // And the area bound does not force a silly zoom on it either.
    expect(minScaleForWall(base.width, base.height, VIEWPORT.width, VIEWPORT.height)).toBeLessThanOrEqual(1)
  })
})
