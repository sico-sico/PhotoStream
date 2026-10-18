/**
 * Distinguishing "the user clicked a photo" from "the user dragged the wall".
 *
 * A plain `click` listener cannot do this: the browser fires it after a drag
 * too. We therefore judge the gesture from pointer down/up geometry.
 */

export interface GestureStart {
  x: number
  y: number
  time: number
}

export const CLICK_MAX_DISTANCE = 6
export const CLICK_MAX_DURATION = 500

/**
 * @param start  where the pointer went down
 * @param end    where it came up
 * @param now    timestamp of pointer up, same clock as `start.time`
 */
export function isClickGesture(start: GestureStart, end: { x: number; y: number }, now: number): boolean {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const distance = Math.hypot(dx, dy)
  if (!Number.isFinite(distance)) return false
  if (distance > CLICK_MAX_DISTANCE) return false

  const duration = now - start.time
  // A zero or negative duration means the clock jumped; treat it as a valid click
  // rather than swallowing the user's input.
  return duration <= CLICK_MAX_DURATION
}

/** Velocity tracker used for flick/inertia after the pointer is released. */
export interface VelocitySample {
  x: number
  y: number
  time: number
}

export interface Velocity {
  vx: number
  vy: number
}

/**
 * Estimate pixels-per-millisecond from recent samples, keeping only samples
 * newer than `windowMs` so the flick reflects the end of the gesture.
 */
export function estimateVelocity(samples: readonly VelocitySample[], windowMs = 100): Velocity {
  if (samples.length < 2) return { vx: 0, vy: 0 }

  const last = samples[samples.length - 1]
  const cutoff = last.time - windowMs

  // Start from the oldest sample still inside the window so a flick reflects
  // the end of the gesture rather than its whole duration. The last index is
  // excluded by construction — starting there would leave zero elapsed time.
  let firstIndex = samples.length - 2
  for (let i = 0; i < samples.length - 1; i += 1) {
    if (samples[i].time >= cutoff) {
      firstIndex = i
      break
    }
  }

  const first = samples[firstIndex]
  const dt = last.time - first.time
  // Zero when every sample shares a timestamp; dividing would be infinite, and
  // a flick that cannot be measured should not move the wall.
  if (dt <= 0) return { vx: 0, vy: 0 }
  return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt }
}

/** Keep only the most recent samples, bounded so a long drag cannot grow memory. */
export function pushSample(samples: VelocitySample[], sample: VelocitySample, limit = 8): VelocitySample[] {
  const next = samples.length >= limit ? samples.slice(samples.length - limit + 1) : samples.slice()
  next.push(sample)
  return next
}
