import { describe, expect, it } from 'vitest'
import {
  CLICK_MAX_DISTANCE,
  CLICK_MAX_DURATION,
  estimateVelocity,
  isClickGesture,
  pushSample,
  type VelocitySample
} from './gesture'

describe('isClickGesture', () => {
  const start = { x: 100, y: 100, time: 1000 }

  it('accepts a still, quick press', () => {
    expect(isClickGesture(start, { x: 100, y: 100 }, 1100)).toBe(true)
  })

  it('accepts movement within the threshold', () => {
    expect(isClickGesture(start, { x: 100 + CLICK_MAX_DISTANCE, y: 100 }, 1100)).toBe(true)
  })

  it('rejects a drag', () => {
    expect(isClickGesture(start, { x: 100 + CLICK_MAX_DISTANCE + 1, y: 100 }, 1100)).toBe(false)
  })

  it('uses euclidean distance, not per-axis', () => {
    // 5px on each axis is ~7.07px total, which exceeds the limit.
    expect(isClickGesture(start, { x: 105, y: 105 }, 1100)).toBe(false)
  })

  it('rejects a long press', () => {
    expect(isClickGesture(start, { x: 100, y: 100 }, 1000 + CLICK_MAX_DURATION + 1)).toBe(false)
  })

  it('accepts a press exactly at the duration limit', () => {
    expect(isClickGesture(start, { x: 100, y: 100 }, 1000 + CLICK_MAX_DURATION)).toBe(true)
  })

  it('rejects non-finite coordinates', () => {
    expect(isClickGesture(start, { x: Number.NaN, y: 100 }, 1100)).toBe(false)
    expect(isClickGesture(start, { x: 100, y: Number.POSITIVE_INFINITY }, 1100)).toBe(false)
  })

  it('accepts a click when the clock jumped backwards', () => {
    // A negative duration means the timestamps are unusable, not that the user
    // held the button for a long time.
    expect(isClickGesture(start, { x: 100, y: 100 }, 500)).toBe(true)
  })
})

describe('estimateVelocity', () => {
  it('returns zero for fewer than two samples', () => {
    expect(estimateVelocity([])).toEqual({ vx: 0, vy: 0 })
    expect(estimateVelocity([{ x: 0, y: 0, time: 0 }])).toEqual({ vx: 0, vy: 0 })
  })

  it('computes pixels per millisecond', () => {
    const samples: VelocitySample[] = [
      { x: 0, y: 0, time: 0 },
      { x: 100, y: 50, time: 100 }
    ]
    expect(estimateVelocity(samples)).toEqual({ vx: 1, vy: 0.5 })
  })

  it('only looks at samples inside the window', () => {
    // Window is `last.time - 50` = 60, so the sample at t=0 is excluded and the
    // measurement starts at t=100: 10px over 10ms.
    const samples: VelocitySample[] = [
      { x: 0, y: 0, time: 0 },
      { x: 1000, y: 0, time: 100 },
      { x: 1010, y: 0, time: 110 }
    ]
    const velocity = estimateVelocity(samples, 50)
    expect(velocity.vx).toBeCloseTo(1, 5)
  })

  it('measures across the whole gesture when the window covers it', () => {
    const samples: VelocitySample[] = [
      { x: 0, y: 0, time: 0 },
      { x: 50, y: 0, time: 50 },
      { x: 100, y: 0, time: 100 }
    ]
    // 100px over 100ms.
    expect(estimateVelocity(samples, 200).vx).toBeCloseTo(1, 5)
  })

  it('returns zero when all samples share a timestamp', () => {
    const samples: VelocitySample[] = [
      { x: 0, y: 0, time: 100 },
      { x: 50, y: 50, time: 100 }
    ]
    expect(estimateVelocity(samples)).toEqual({ vx: 0, vy: 0 })
  })

  it('measures from the oldest sample when the window excludes everything', () => {
    // With a 5ms window only the last sample qualifies; using it as the start
    // would divide by zero, so the whole gesture is measured instead.
    const samples: VelocitySample[] = [
      { x: 0, y: 0, time: 0 },
      { x: 10, y: 10, time: 10 }
    ]
    const velocity = estimateVelocity(samples, 5)
    expect(velocity.vx).toBeCloseTo(1, 5)
    expect(velocity.vy).toBeCloseTo(1, 5)
  })
})

describe('pushSample', () => {
  it('appends below the limit', () => {
    const samples = pushSample([], { x: 1, y: 1, time: 1 }, 3)
    expect(samples).toHaveLength(1)
  })

  it('keeps at most `limit` samples, dropping the oldest', () => {
    let samples: VelocitySample[] = []
    for (let i = 0; i < 10; i += 1) samples = pushSample(samples, { x: i, y: i, time: i }, 4)
    expect(samples).toHaveLength(4)
    expect(samples.map((s) => s.x)).toEqual([6, 7, 8, 9])
  })

  it('does not mutate the input array', () => {
    const original: VelocitySample[] = [{ x: 0, y: 0, time: 0 }]
    const next = pushSample(original, { x: 1, y: 1, time: 1 }, 8)
    expect(original).toHaveLength(1)
    expect(next).toHaveLength(2)
  })
})
