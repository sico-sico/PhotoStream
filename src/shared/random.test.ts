import { describe, expect, it } from 'vitest'
import { centreBoxFor, mulberry32, pickRandom, scatterAround, type Box } from './random'

/**
 * The random show's geometry.
 *
 * Placement is the part that can go visibly wrong — overlapping photos, photos
 * hanging off the edge, a centre photo that overflows — so it is pinned here
 * rather than eyeballed. The RNG is seeded, so every assertion is deterministic.
 */

const VIEWPORT = { width: 1600, height: 956 }

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

describe('mulberry32', () => {
  it('is deterministic for a seed', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })

  it('differs between seeds', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)())
  })

  it('stays in [0, 1)', () => {
    const rng = mulberry32(7)
    for (let i = 0; i < 500; i += 1) {
      const value = rng()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})

describe('pickRandom', () => {
  const pool = ['a', 'b', 'c', 'd', 'e', 'f']

  it('returns the requested count without repeats', () => {
    const picked = pickRandom(pool, 4, mulberry32(3))
    expect(picked).toHaveLength(4)
    expect(new Set(picked).size).toBe(4)
  })

  it('never returns more than the pool holds', () => {
    expect(pickRandom(pool, 100, mulberry32(3))).toHaveLength(pool.length)
  })

  it('does not mutate the pool', () => {
    const original = [...pool]
    pickRandom(pool, 4, mulberry32(3))
    expect(pool).toEqual(original)
  })

  it('skips excluded items', () => {
    // Turnover must not re-show what is already on screen.
    const picked = pickRandom(pool, 3, mulberry32(5), new Set(['a', 'b']))
    expect(picked).not.toContain('a')
    expect(picked).not.toContain('b')
    expect(picked).toHaveLength(3)
  })

  it('returns nothing when everything is excluded', () => {
    expect(pickRandom(pool, 3, mulberry32(5), new Set(pool))).toEqual([])
  })

  it('accepts a key function, so it works on objects', () => {
    const items = [{ id: 'x' }, { id: 'y' }, { id: 'z' }]
    const picked = pickRandom(items, 2, mulberry32(9), new Set(['y']), (item) => item.id)
    expect(picked.map((item) => item.id)).not.toContain('y')
    expect(picked).toHaveLength(2)
  })
})

describe('centreBoxFor', () => {
  it('leaves a square photo at the requested fraction of the shorter side', () => {
    // Contain, not cover: a square at 50% of a 1600x956 window is 478x478 —
    // limited by the height, because anything larger would not fit.
    const box = centreBoxFor(1, VIEWPORT, 0.5)
    expect(box.w).toBeCloseTo(VIEWPORT.height * 0.5, 6)
    expect(box.h).toBeCloseTo(VIEWPORT.height * 0.5, 6)
  })

  it('centres the box', () => {
    const box = centreBoxFor(1.5, VIEWPORT, 0.5)
    expect(box.x + box.w / 2).toBeCloseTo(VIEWPORT.width / 2, 6)
    expect(box.y + box.h / 2).toBeCloseTo(VIEWPORT.height / 2, 6)
  })

  it('is limited by height for a portrait photo', () => {
    // A tall photo must be contained by the window height, not overflow it.
    const box = centreBoxFor(0.4, VIEWPORT, 0.5)
    expect(box.h).toBeCloseTo(VIEWPORT.height * 0.5, 6)
    expect(box.w).toBeCloseTo(box.h * 0.4, 6)
    expect(box.w).toBeLessThanOrEqual(VIEWPORT.width)
  })

  it('is limited by width for a panorama', () => {
    const box = centreBoxFor(4, VIEWPORT, 0.5)
    expect(box.w).toBeCloseTo(VIEWPORT.width * 0.5, 6)
    expect(box.h).toBeCloseTo(box.w / 4, 6)
  })

  it('falls back to a square for a broken aspect', () => {
    for (const aspect of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const box = centreBoxFor(aspect, VIEWPORT, 0.5)
      expect(box.w).toBeCloseTo(box.h, 6)
      expect(box.w).toBeGreaterThan(0)
    }
  })
})

describe('scatterAround', () => {
  const centre = centreBoxFor(1.5, VIEWPORT, 0.5)

  function scatter(count: number, seed = 11) {
    const candidates = Array.from({ length: count }, (_, i) => ({
      id: `p${i}`,
      // A mix of portrait and landscape, as a real library has.
      aspect: i % 3 === 0 ? 0.66 : i % 3 === 1 ? 1.5 : 1
    }))
    return scatterAround({ candidates, viewport: VIEWPORT, centre, rng: mulberry32(seed) })
  }

  it('places photos without overlapping the centre photo', () => {
    const placed = scatter(40)
    expect(placed.length).toBeGreaterThan(0)
    for (const box of placed) {
      expect(intersects(box, centre)).toBe(false)
    }
  })

  it('allows a little overlap, but never more than a quarter of a photo', () => {
    // Overlap is what makes the photos read as stacked objects rather than as
    // cells in a grid. It has to be bounded, though: a photo mostly hidden behind
    // a neighbour is worse than one that was never drawn.
    const placed = scatter(60)
    let overlapping = 0
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i]
        const b = placed[j]
        const dx = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
        const dy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
        if (dx <= 0 || dy <= 0) continue
        overlapping += 1
        // The limit is on covered *area*, so a corner clip is allowed however
        // long its edges are; what must not happen is one photo sitting squarely
        // on top of another.
        const smaller = Math.min(a.w * a.h, b.w * b.h)
        expect((dx * dy) / smaller).toBeLessThanOrEqual(0.25 + 0.001)
      }
    }
    // And overlap actually happens — otherwise the feature is not wired up.
    expect(overlapping).toBeGreaterThan(0)
  })

  it('keeps the centre photo clear of the ring', () => {
    // Overlap is allowed between small photos; the subject is not covered.
    for (const box of scatter(60)) {
      expect(intersects(box, centre)).toBe(false)
    }
  })

  it('keeps every photo inside the window', () => {
    for (const box of scatter(40)) {
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.x + box.w).toBeLessThanOrEqual(VIEWPORT.width)
      expect(box.y + box.h).toBeLessThanOrEqual(VIEWPORT.height)
    }
  })

  it('gives photos different sizes, so it reads as a cloud and not a grid', () => {
    const placed = scatter(40)
    const sizes = new Set(placed.map((box) => Math.round(box.w)))
    expect(sizes.size).toBeGreaterThan(3)
  })

  it('gives a portrait and a landscape the same visual weight for the same size', () => {
    // Area is size^2 regardless of aspect, so neither dominates the cloud. The
    // size itself is drawn from the RNG, so each candidate is placed alone with
    // the same seed: that makes the drawn size identical and isolates the aspect.
    const place = (aspect: number) =>
      scatterAround({
        candidates: [{ id: 'only', aspect }],
        viewport: VIEWPORT,
        centre,
        rng: mulberry32(4)
      })[0]

    const tall = place(0.5)
    const wide = place(2)
    expect(tall.w * tall.h).toBeCloseTo(wide.w * wide.h, 3)
    // And each keeps its own proportions, so a portrait is not squashed.
    expect(tall.w / tall.h).toBeCloseTo(0.5, 6)
    expect(wide.w / wide.h).toBeCloseTo(2, 6)
  })

  it('is deterministic, so a layout can be reproduced', () => {
    const a = scatter(24, 7)
    const b = scatter(24, 7)
    expect(a.map((box) => [box.id, Math.round(box.x), Math.round(box.y)])).toEqual(
      b.map((box) => [box.id, Math.round(box.x), Math.round(box.y)])
    )
  })

  it('drops candidates when the window runs out of room', () => {
    // 200 photos cannot all fit; returning fewer is the expected behaviour, not
    // an error, and nothing may overlap.
    const placed = scatter(200)
    expect(placed.length).toBeGreaterThan(10)
    expect(placed.length).toBeLessThan(200)
  })

  it('returns nothing for an empty pool or a zero-size window', () => {
    expect(scatterAround({ candidates: [], viewport: VIEWPORT, centre, rng: mulberry32(1) })).toEqual([])
    expect(
      scatterAround({
        candidates: [{ id: 'a', aspect: 1 }],
        viewport: { width: 0, height: 0 },
        centre,
        rng: mulberry32(1)
      })
    ).toEqual([])
  })

  describe('pose', () => {
    it('tilts every photo, but never so far that it looks crooked', () => {
      const placed = scatter(40)
      expect(placed.length).toBeGreaterThan(5)
      for (const box of placed) {
        // A flat photo next to tilted ones reads as a mistake, so zero is
        // excluded by construction; the cap keeps the subject upright.
        expect(Math.abs(box.rotate)).toBeGreaterThan(0)
        expect(Math.abs(box.rotate)).toBeLessThanOrEqual(4)
      }
    })

    it('tilts photos in both directions, so the cloud does not lean one way', () => {
      const rotations = scatter(60).map((box) => box.rotate)
      expect(rotations.some((r) => r > 0)).toBe(true)
      expect(rotations.some((r) => r < 0)).toBe(true)
    })

    it('gives photos different float periods, so they never pulse in unison', () => {
      const periods = scatter(40).map((box) => box.floatSeconds)
      expect(new Set(periods.map((p) => p.toFixed(2))).size).toBeGreaterThan(3)
      for (const period of periods) {
        // Long enough to read as drifting rather than as jitter.
        expect(period).toBeGreaterThan(5)
        expect(period).toBeLessThan(11)
      }
    })

    it('starts each photo at a different phase', () => {
      // A negative delay means the animation is already partway through on the
      // first frame, which is what stops a fresh batch from bobbing together.
      const delays = scatter(40).map((box) => box.floatDelay)
      expect(new Set(delays.map((d) => d.toFixed(2))).size).toBeGreaterThan(3)
      for (const delay of delays) {
        expect(delay).toBeLessThanOrEqual(0)
        expect(delay).toBeGreaterThanOrEqual(-8)
      }
    })

    it('spreads depth across the whole 0..1 range', () => {
      const depths = scatter(60).map((box) => box.depth)
      for (const depth of depths) {
        expect(depth).toBeGreaterThanOrEqual(0)
        expect(depth).toBeLessThanOrEqual(1)
      }
      // A batch that all sat at the same depth would look flat.
      expect(Math.max(...depths) - Math.min(...depths)).toBeGreaterThan(0.5)
    })

    it('is reproducible with the pose included', () => {
      const a = scatter(20, 9)
      const b = scatter(20, 9)
      expect(a.map((box) => [box.id, box.rotate.toFixed(3), box.depth.toFixed(3)])).toEqual(
        b.map((box) => [box.id, box.rotate.toFixed(3), box.depth.toFixed(3)])
      )
    })

    describe('3D pose', () => {
      it('turns every photo out of the screen plane', () => {
        // A photo with no rotateX/rotateY is a flat rectangle; the whole point of
        // the 3D pass is that none of them are flat.
        for (const box of scatter(40)) {
          expect(Math.abs(box.tiltX)).toBeGreaterThan(0)
          expect(Math.abs(box.tiltY)).toBeGreaterThan(0)
        }
      })

      it('keeps the tilt gentle enough to read', () => {
        // Past about 12 degrees the perspective warps straight lines noticeably
        // and the photo stops looking like a print.
        for (const box of scatter(60)) {
          expect(Math.abs(box.tiltX)).toBeLessThanOrEqual(12)
          expect(Math.abs(box.tiltY)).toBeLessThanOrEqual(13)
        }
      })

      it('tilts in both directions, so the scene has no overall lean', () => {
        const placed = scatter(60)
        expect(placed.some((box) => box.tiltX > 0)).toBe(true)
        expect(placed.some((box) => box.tiltX < 0)).toBe(true)
        expect(placed.some((box) => box.tiltY > 0)).toBe(true)
        expect(placed.some((box) => box.tiltY < 0)).toBe(true)
      })

      it('turns distant photos away more than near ones', () => {
        // A fanned-out group exaggerates the far ones. Averaged over many photos
        // so the per-photo randomness does not swamp the trend.
        const placed = scatter(90)
        const near = placed.filter((box) => box.depth > 0.66)
        const far = placed.filter((box) => box.depth < 0.33)
        if (near.length > 4 && far.length > 4) {
          const mean = (boxes: typeof placed) =>
            boxes.reduce((sum, box) => sum + Math.abs(box.tiltY), 0) / boxes.length
          expect(mean(far)).toBeGreaterThan(mean(near))
        }
      })

      it('is reproducible with the tilt included', () => {
        const a = scatter(20, 9)
        const b = scatter(20, 9)
        expect(a.map((box) => box.tiltX.toFixed(3))).toEqual(b.map((box) => box.tiltX.toFixed(3)))
      })
    })
  })
})
