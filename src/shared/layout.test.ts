import { describe, expect, it } from 'vitest'
import type { Photo } from './types'
import { LAYOUT_DEFAULTS, computeLayout, layoutBounds } from './layout'

function photo(id: string, width: number, height: number): Photo {
  return { id, path: `/p/${id}.jpg`, name: `${id}.jpg`, width, height, takenAt: '', dateSource: 'none', mtimeMs: 0, sizeBytes: 0 }
}

const landscape = photo('l', 6000, 4000) // 1.5
const portrait = photo('p', 4000, 6000) // 0.667
const square = photo('s', 4000, 4000) // 1

describe('computeLayout', () => {
  it('returns an empty world for no photos', () => {
    const result = computeLayout([], { mode: 'grid', containerWidth: 1000 })
    expect(result.items).toEqual([])
    expect(result.height).toBe(0)
  })

  it('lays out every photo exactly once', () => {
    const photos = [landscape, portrait, square]
    for (const mode of ['grid', 'masonry', 'square'] as const) {
      const result = computeLayout(photos, { mode, containerWidth: 1000 })
      expect(result.items.map((item) => item.id), mode).toEqual(['l', 'p', 's'])
    }
  })

  it('never produces overlapping tiles', () => {
    const photos = Array.from({ length: 20 }, (_, i) => photo(`p${i}`, 100 + i * 40, 200))

    for (const mode of ['grid', 'masonry', 'square'] as const) {
      const { items } = computeLayout(photos, { mode, containerWidth: 1200 })
      for (let i = 0; i < items.length; i += 1) {
        for (let j = i + 1; j < items.length; j += 1) {
          const a = items[i]
          const b = items[j]
          const overlaps = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
          expect(overlaps, `${mode}: ${a.id} overlaps ${b.id}`).toBe(false)
        }
      }
    }
  })

  it('keeps every tile inside the reported world box', () => {
    const photos = Array.from({ length: 15 }, (_, i) => photo(`p${i}`, 3000 + i * 100, 2000))

    for (const mode of ['grid', 'masonry', 'square'] as const) {
      const result = computeLayout(photos, { mode, containerWidth: 1000 })
      for (const item of result.items) {
        expect(item.x + item.w, mode).toBeLessThanOrEqual(result.width + 0.01)
        expect(item.y + item.h, mode).toBeLessThanOrEqual(result.height + 0.01)
      }
    }
  })

  describe('square mode', () => {
    it('gives every tile the same size', () => {
      const { items } = computeLayout([landscape, portrait, square], { mode: 'square', containerWidth: 1000 })
      expect(new Set(items.map((item) => item.w))).toEqual(new Set([LAYOUT_DEFAULTS.cellSize]))
      expect(new Set(items.map((item) => item.h))).toEqual(new Set([LAYOUT_DEFAULTS.cellSize]))
    })

    it('fits whole columns inside the container plus one gap of slack', () => {
      // floor((1000 + 8) / (200 + 8)) = 4 columns
      const { items } = computeLayout(Array.from({ length: 9 }, (_, i) => photo(`p${i}`, 1, 1)), {
        mode: 'square',
        containerWidth: 1000
      })
      const distinctX = new Set(items.map((item) => item.x))
      expect(distinctX.size).toBe(4)
    })

    it('uses at least one column for a very narrow container', () => {
      const { items } = computeLayout([landscape], { mode: 'square', containerWidth: 10 })
      expect(items[0].x).toBe(0)
    })
  })

  describe('masonry mode', () => {
    it('uses the requested column width', () => {
      const { items } = computeLayout([landscape, portrait], { mode: 'masonry', containerWidth: 1000, columnWidth: 200 })
      expect(items.every((item) => item.w === 200)).toBe(true)
    })

    it('preserves the aspect ratio', () => {
      const { items } = computeLayout([landscape, portrait], { mode: 'masonry', containerWidth: 1000, columnWidth: 200 })
      expect(items[0].h).toBeCloseTo(200 / 1.5, 1)
      expect(items[1].h).toBeCloseTo(200 / (2 / 3), 1)
    })

    it('starts a new column rather than stacking everything in one', () => {
      const photos = Array.from({ length: 6 }, (_, i) => photo(`p${i}`, 2000, 1000))
      const { items } = computeLayout(photos, { mode: 'masonry', containerWidth: 1000, columnWidth: 200 })
      expect(new Set(items.map((item) => item.x)).size).toBeGreaterThan(1)
      expect(items[0].y).toBe(0)
    })
  })

  describe('grid (justified rows) mode', () => {
    it('makes each non-final row span the container width', () => {
      const photos = Array.from({ length: 12 }, (_, i) => photo(`p${i}`, 3000, 2000))
      const { items } = computeLayout(photos, { mode: 'grid', containerWidth: 1000, targetRowHeight: 200 })
      const rows = new Map<number, typeof items>()
      for (const item of items) {
        const row = rows.get(item.y) ?? []
        row.push(item)
        rows.set(item.y, row)
      }
      const rowKeys = [...rows.keys()].sort((a, b) => a - b)
      // All but the last row should reach the right edge.
      for (const key of rowKeys.slice(0, -1)) {
        const row = rows.get(key)!
        const right = Math.max(...row.map((item) => item.x + item.w))
        expect(right).toBeCloseTo(1000, 0)
      }
    })

    it('does not stretch the final short row', () => {
      const photos = [photo('a', 3000, 2000), photo('b', 3000, 2000)]
      const { items } = computeLayout(photos, { mode: 'grid', containerWidth: 1000, targetRowHeight: 200 })
      expect(items[0].h).toBe(200)
      expect(items[0].w).toBeCloseTo(300, 0)
    })

    it('preserves aspect ratios', () => {
      const photos = [photo('a', 3000, 2000), photo('b', 2000, 3000), photo('c', 1000, 1000)]
      for (const item of computeLayout(photos, { mode: 'grid', containerWidth: 700 }).items) {
        const source = photos.find((p) => p.id === item.id)!
        expect(item.w / item.h).toBeCloseTo(source.width / source.height, 1)
      }
    })
  })

  describe('defensive behaviour', () => {
    it('falls back to a square cell when dimensions are missing', () => {
      const broken = photo('x', 0, 0)
      const { items } = computeLayout([broken], { mode: 'masonry', containerWidth: 1000, columnWidth: 200 })
      expect(items[0].h).toBe(200)
    })

    it('clamps absurd panoramas instead of producing a hairline', () => {
      const panorama = photo('wide', 20000, 100)
      const { items } = computeLayout([panorama], { mode: 'masonry', containerWidth: 1000, columnWidth: 200 })
      // Aspect is clamped to 5, so the height is 200/5 = 40 instead of 1.
      expect(items[0].h).toBeCloseTo(40, 0)
    })

    it('treats a zero container width as one pixel', () => {
      const { items } = computeLayout([landscape], { mode: 'square', containerWidth: 0 })
      expect(items).toHaveLength(1)
    })

    it('is deterministic', () => {
      const photos = Array.from({ length: 8 }, (_, i) => photo(`p${i}`, 1000 + i * 50, 1500))
      const first = computeLayout(photos, { mode: 'grid', containerWidth: 900 })
      const second = computeLayout(photos, { mode: 'grid', containerWidth: 900 })
      expect(first).toEqual(second)
    })
  })
})

describe('layoutBounds', () => {
  it('returns zero for no items', () => {
    expect(layoutBounds([])).toEqual({ width: 0, height: 0 })
  })

  it('measures the far edge of the content', () => {
    expect(
      layoutBounds([
        { id: 'a', x: 0, y: 0, w: 100, h: 50 },
        { id: 'b', x: 80, y: 40, w: 60, h: 100 }
      ])
    ).toEqual({ width: 140, height: 140 })
  })
})
