/**
 * Viewport transform maths for the wall.
 *
 * The wall lives in "world" coordinates. The renderer maps world -> screen with
 *
 *   screen = world * scale + translate
 *
 * Keeping this in one place means the pan/zoom gesture code stays declarative
 * and the invariants (anchor under cursor, clamped scale) are unit-testable
 * without a browser.
 */

export interface Transform {
  scale: number
  x: number
  y: number
}

export const MIN_SCALE = 0.05
export const MAX_SCALE = 12

/**
 * Smallest scale an automatic fit is allowed to use.
 *
 * Fitting a very tall wall (thousands of photos) into one window produced a
 * scale of 0.05, which pinned the view to `MIN_SCALE`: every tile was 16px and
 * the wheel appeared to do nothing. A fit never goes below this, so a large
 * library opens at a readable size and the user pans instead of squinting.
 */
export const MIN_FIT_SCALE = 0.22

export const IDENTITY: Transform = { scale: 1, x: 0, y: 0 }

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min
  return Math.min(Math.max(value, min), max)
}

export function clampScale(scale: number, min = MIN_SCALE, max = MAX_SCALE): number {
  return clamp(scale, min, max)
}

/** Convert a screen-space point into world space. */
export function screenToWorld(t: Transform, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - t.x) / t.scale, y: (sy - t.y) / t.scale }
}

/** Convert a world-space point into screen space. */
export function worldToScreen(t: Transform, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * t.scale + t.x, y: wy * t.scale + t.y }
}

/**
 * Zoom to `nextScale` while keeping the world point under (`sx`,`sy`) pinned to
 * that same screen position. This is what makes wheel zoom feel anchored to the
 * cursor rather than to the window centre.
 */
export function zoomAt(
  t: Transform,
  nextScale: number,
  sx: number,
  sy: number,
  min = MIN_SCALE,
  max = MAX_SCALE
): Transform {
  const scale = clampScale(nextScale, min, max)
  if (scale === t.scale) return t
  // Solve  sx = wx * scale + x  for x, with wx held constant.
  const world = screenToWorld(t, sx, sy)
  return {
    scale,
    x: sx - world.x * scale,
    y: sy - world.y * scale
  }
}

/**
 * Apply a wheel delta.
 *
 * `deltaMode` differs between mice (pixels), trackpads (pixels, but much
 * smaller) and some drivers (lines/pages). Normalising first keeps the feel
 * consistent; the exponential curve keeps zoom steps perceptually even.
 */
export function zoomByWheel(
  t: Transform,
  deltaY: number,
  deltaMode: number,
  sx: number,
  sy: number,
  options: { speed?: number; min?: number; max?: number } = {}
): Transform {
  const speed = options.speed ?? 0.0015
  const unit = deltaMode === 1 ? 33 : deltaMode === 2 ? 800 : 1
  const normalised = deltaY * unit
  const next = t.scale * Math.exp(-normalised * speed)
  return zoomAt(t, next, sx, sy, options.min ?? MIN_SCALE, options.max ?? MAX_SCALE)
}

/** Translate by a screen-space delta. */
export function panBy(t: Transform, dx: number, dy: number): Transform {
  return { scale: t.scale, x: t.x + dx, y: t.y + dy }
}

export interface FitOptions {
  padding?: number
  /** Never scale above this, so a one-photo wall does not fill the screen. */
  maxScale?: number
  /** Never scale below this, so a huge wall stays readable. Defaults to `MIN_FIT_SCALE`. */
  minScale?: number
  center?: boolean
}

/**
 * Scale/translate so the world fits the viewport, within readable bounds.
 *
 * When the wall is too tall to fit at a readable scale, this aligns to the top
 * and left instead of shrinking further: the content simply extends past the
 * viewport, which is what panning is for.
 */
export function fitTransform(
  worldWidth: number,
  worldHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  options: FitOptions = {}
): Transform {
  const padding = options.padding ?? 24
  const maxScale = options.maxScale ?? 1
  const minScale = options.minScale ?? MIN_FIT_SCALE
  const usableW = Math.max(1, viewportWidth - padding * 2)
  const usableH = Math.max(1, viewportHeight - padding * 2)
  if (worldWidth <= 0 || worldHeight <= 0) return { ...IDENTITY }

  const raw = Math.min(usableW / worldWidth, usableH / worldHeight, maxScale)
  const scale = clampScale(Math.max(raw, minScale), minScale, maxScale)

  if (options.center === false || raw < minScale) {
    // Too large to fit legibly: start at the top-left corner.
    return { scale, x: padding, y: padding }
  }

  return {
    scale,
    x: (viewportWidth - worldWidth * scale) / 2,
    y: (viewportHeight - worldHeight * scale) / 2
  }
}

/** Visible world rectangle for a viewport, used for culling and LOD decisions. */
export function visibleWorldRect(
  t: Transform,
  viewportWidth: number,
  viewportHeight: number
): { x: number; y: number; width: number; height: number } {
  const topLeft = screenToWorld(t, 0, 0)
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: viewportWidth / t.scale,
    height: viewportHeight / t.scale
  }
}

/** Identity check that tolerates floating point noise from repeated gestures. */
export function transformsEqual(a: Transform, b: Transform, epsilon = 1e-6): boolean {
  return (
    Math.abs(a.scale - b.scale) < epsilon &&
    Math.abs(a.x - b.x) < epsilon &&
    Math.abs(a.y - b.y) < epsilon
  )
}
