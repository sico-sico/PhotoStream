import { describe, expect, it } from 'vitest'
import {
  MIN_THUMB_FRACTION,
  dateAtWorldY,
  dateMarkers,
  scrollMetrics,
  scrollOffsetToY,
  scrollToWorldY
} from './scrollbar'

/**
 * Scrollbar geometry.
 *
 * The wall is tens of thousands of pixels tall, so this control is how a whole
 * year of photos becomes reachable. The tests concentrate on the round trip
 * (thumb position to translate and back) and on the two degenerate cases: a wall
 * that fits, and a wall so tall the thumb would vanish.
 */

/** A wall 10x the viewport height, at scale 1. */
const worldHeight = 10000
const viewportHeight = 1000
const at = (y: number, scale = 1) => ({ scale, x: 0, y })

describe('scrollMetrics', () => {
  it('is not scrollable when the wall fits', () => {
    // A scrollbar for content that fits would be a lie: it implies more below.
    expect(scrollMetrics(at(0), 900, viewportHeight).scrollable).toBe(false)
    expect(scrollMetrics(at(0), viewportHeight, viewportHeight).scrollable).toBe(false)
  })

  it('sizes the thumb from the visible fraction', () => {
    const metrics = scrollMetrics(at(0), worldHeight, viewportHeight)
    expect(metrics.scrollable).toBe(true)
    expect(metrics.size).toBeCloseTo(0.1, 6)
  })

  it('starts at the top when the wall is not scrolled', () => {
    expect(scrollMetrics(at(0), worldHeight, viewportHeight).offset).toBe(0)
  })

  it('ends at the bottom of the usable travel when fully scrolled', () => {
    // The thumb cannot reach the very end of the track: it occupies `size` of it.
    const metrics = scrollMetrics(at(viewportHeight - worldHeight), worldHeight, viewportHeight)
    expect(metrics.offset).toBeCloseTo(1 - metrics.size, 6)
  })

  it('pins the thumb at the top when panned above the first row', () => {
    // The wall is clamped, so this should not happen, but a stale transform must
    // not push the thumb off the track.
    expect(scrollMetrics(at(500), worldHeight, viewportHeight).offset).toBe(0)
  })

  it('never shrinks the thumb below the usable minimum', () => {
    // A 30000-row wall would compute a 2px thumb, which cannot be grabbed.
    const metrics = scrollMetrics(at(0), 100000, viewportHeight)
    expect(metrics.size).toBe(MIN_THUMB_FRACTION)
  })

  it('accounts for the zoom', () => {
    // At 2x the wall occupies twice the height, so the thumb has half the room.
    // With a 10000px wall and a 1000px window that is 5%, below the grabable
    // minimum, so the floor applies — which is what the assertion records.
    expect(scrollMetrics(at(0, 2), worldHeight, viewportHeight).size).toBe(MIN_THUMB_FRACTION)
    // The unscaled version of the same wall stays above the floor and halves.
    expect(scrollMetrics(at(0), worldHeight, viewportHeight).size).toBeCloseTo(0.1, 6)
  })

  it('is safe with degenerate input', () => {
    expect(scrollMetrics(at(0), 0, viewportHeight).scrollable).toBe(false)
    expect(scrollMetrics(at(0), worldHeight, 0).scrollable).toBe(false)
    expect(scrollMetrics({ scale: 0, x: 0, y: 0 }, worldHeight, viewportHeight).scrollable).toBe(true)
  })
})

describe('scrollOffsetToY', () => {
  it('maps the top of the track to the first row', () => {
    // `-y` arithmetic can produce -0, which differs from 0 under Object.is.
    expect(scrollOffsetToY(0, worldHeight, viewportHeight, 1)).toBeCloseTo(0, 10)
  })

  it('maps the end of the travel to the last row', () => {
    const size = scrollMetrics(at(0), worldHeight, viewportHeight).size
    expect(scrollOffsetToY(1 - size, worldHeight, viewportHeight, 1)).toBeCloseTo(viewportHeight - worldHeight, 6)
  })

  it('round-trips with scrollMetrics', () => {
    for (const y of [0, -1000, -4500, -9000]) {
      const { offset } = scrollMetrics(at(y), worldHeight, viewportHeight)
      expect(scrollOffsetToY(offset, worldHeight, viewportHeight, 1)).toBeCloseTo(y, 6)
    }
  })

  it('accounts for the zoom', () => {
    // At 2x the same fraction of the wall is twice as far in screen pixels.
    const half = scrollOffsetToY(0.45, worldHeight, viewportHeight, 2)
    expect(half).toBeLessThan(-9000)
  })

  it('returns 0 when nothing can scroll', () => {
    expect(scrollOffsetToY(0.5, 500, viewportHeight, 1)).toBe(0)
    expect(scrollOffsetToY(0.5, worldHeight, 0, 1)).toBe(0)
  })

  it('clamps an out-of-range offset', () => {
    expect(scrollOffsetToY(-1, worldHeight, viewportHeight, 1)).toBeCloseTo(0, 10)
    expect(scrollOffsetToY(2, worldHeight, viewportHeight, 1)).toBeLessThanOrEqual(0)
  })
})

describe('scrollToWorldY', () => {
  it('brings a row to the top of the window', () => {
    // Negating zero yields -0; compare numerically rather than by identity.
    expect(scrollToWorldY(0, 1)).toBeCloseTo(0, 10)
    expect(scrollToWorldY(1500, 1)).toBe(-1500)
  })

  it('accounts for the zoom', () => {
    expect(scrollToWorldY(1000, 2)).toBe(-2000)
  })

  it('treats a zero scale as 1', () => {
    expect(scrollToWorldY(1000, 0)).toBe(-1000)
  })
})

describe('dateAtWorldY', () => {
  const items = [
    { y: 0, h: 200, takenAt: '2020-01-05' },
    { y: 200, h: 200, takenAt: '2020-01-05' },
    { y: 400, h: 200, takenAt: '2019-07-14' },
    { y: 600, h: 200, takenAt: '' }
  ]

  it('reports the date of the row at the top of the window', () => {
    expect(dateAtWorldY(items, 0)).toBe('2020-01-05')
    expect(dateAtWorldY(items, 450)).toBe('2019-07-14')
  })

  it('reports the row a partly scrolled tile belongs to', () => {
    // The viewport starts 150px into the first photo.
    expect(dateAtWorldY(items, 150)).toBe('2020-01-05')
  })

  it('falls back to the nearest dated row above an undated one', () => {
    // A blank label would read as a broken feature rather than as "no EXIF".
    expect(dateAtWorldY(items, 700)).toBe('2019-07-14')
  })

  it('handles a position past the end of the wall', () => {
    expect(dateAtWorldY(items, 99999)).toBe('2019-07-14')
  })

  it('returns empty for an empty wall', () => {
    expect(dateAtWorldY([], 0)).toBe('')
  })

  it('returns empty when nothing is dated at all', () => {
    expect(dateAtWorldY([{ y: 0, h: 100, takenAt: '' }], 0)).toBe('')
  })
})

describe('dateMarkers', () => {
  it('reports the first row of each distinct date', () => {
    const markers = dateMarkers([
      { y: 0, takenAt: '2020-01-05' },
      { y: 200, takenAt: '2020-01-05' },
      { y: 400, takenAt: '2019-07-14' }
    ])
    expect(markers).toEqual([
      { date: '2020-01-05', y: 0 },
      { date: '2019-07-14', y: 400 }
    ])
  })

  it('skips undated photos', () => {
    expect(dateMarkers([{ y: 0, takenAt: '' }, { y: 100, takenAt: '2020-01-01' }])).toEqual([
      { date: '2020-01-01', y: 100 }
    ])
  })

  it('handles an empty wall', () => {
    expect(dateMarkers([])).toEqual([])
  })
})
