import { describe, expect, it } from 'vitest'
import { wheelIntent, wheelPan } from './wheel'

/**
 * Wheel gesture routing.
 *
 * The convention everywhere else — browsers, image viewers, maps — is that a
 * bare wheel scrolls and a modified wheel zooms. PhotoStream shipped the
 * opposite, so this pins the expected behaviour.
 */

describe('wheelIntent', () => {
  it('pans on a bare wheel', () => {
    // The first gesture most people try. Zooming here instead moves the
    // magnifications when the user meant to move through the library.
    expect(wheelIntent({ ctrlKey: false, metaKey: false })).toBe('pan')
  })

  it('zooms with Ctrl', () => {
    expect(wheelIntent({ ctrlKey: true, metaKey: false })).toBe('zoom')
  })

  it('zooms with Cmd, the macOS equivalent', () => {
    expect(wheelIntent({ ctrlKey: false, metaKey: true })).toBe('zoom')
  })

  it('zooms when both are held', () => {
    expect(wheelIntent({ ctrlKey: true, metaKey: true })).toBe('zoom')
  })
})

describe('wheelPan', () => {
  // `toEqual` distinguishes -0 from 0, and negating a zero delta produces -0.
  // Compare numerically so the sign of a zero is not the subject of the test.
  const expectPan = (actual: { dx: number; dy: number }, dx: number, dy: number): void => {
    expect(actual.dx).toBeCloseTo(dx, 10)
    expect(actual.dy).toBeCloseTo(dy, 10)
  }

  it('moves the content opposite to the scroll direction', () => {
    // Scrolling down (positive deltaY) reveals what is below, which is a
    // negative translate.
    expectPan(wheelPan(0, 100, 0), 0, -100)
    expectPan(wheelPan(0, -100, 0), 0, 100)
  })

  it('passes the horizontal component through', () => {
    // Shift+wheel and a trackpad's sideways motion both arrive as deltaX;
    // dropping it would make horizontal movement impossible on those devices.
    expectPan(wheelPan(50, 0, 0), -50, 0)
  })

  it('normalises line and page deltas', () => {
    // Some drivers report lines rather than pixels; without normalisation a
    // single notch would move one pixel.
    expectPan(wheelPan(0, 3, 1), 0, -99)
    expectPan(wheelPan(0, 1, 2), 0, -800)
  })

  it('treats an unknown delta mode as pixels', () => {
    expectPan(wheelPan(0, 40, 0), 0, -40)
  })

  it('is a no-op for a zero delta', () => {
    expectPan(wheelPan(0, 0, 0), 0, 0)
  })
})
