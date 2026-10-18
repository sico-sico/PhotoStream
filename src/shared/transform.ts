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
 * Frame a photo wall.
 *
 * A wall is an endless vertical strip, not a picture: a 3226-photo wall is
 * ~140000px tall. Fitting *both* axes therefore computes a scale near zero and
 * either shrinks the whole library to thumbnails or clamps to `MIN_FIT_SCALE`
 * and leaves most of the window empty — which is exactly what looked like "the
 * thumbnails don't fill the window".
 *
 * So a wall is fitted by **width** and anchored to the top:
 * - the width is *covered*, never merely fitted, so no gap can appear at the
 *   sides regardless of rounding in the layout;
 * - padding defaults to zero, because a photo wall reads best edge-to-edge;
 * - everything below the fold is reached by panning.
 */
export function fitWallTransform(
  worldWidth: number,
  worldHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  options: FitOptions = {}
): Transform {
  // Zero, not 24: a wall should reach the window edges.
  const padding = options.padding ?? 0
  const maxScale = options.maxScale ?? 1
  const minScale = options.minScale ?? MIN_FIT_SCALE
  if (worldWidth <= 0 || worldHeight <= 0) return { ...IDENTITY }

  const usableW = Math.max(1, viewportWidth - padding * 2)
  // `max` (cover), not `min` (contain): fitting loosely would reintroduce the
  // side gaps caused by the layout being rounded to two decimals.
  const raw = usableW / worldWidth
  const scale = clampScale(raw, minScale, maxScale)

  const scaledWidth = worldWidth * scale
  // Only centre when the wall is meaningfully narrower (a small library in a
  // wide window). A sub-pixel shortfall from layout rounding must not turn into
  // a visible margin, so the comparison has a tolerance.
  const slack = viewportWidth - scaledWidth
  const x = slack > 1 ? slack / 2 : padding

  void viewportHeight
  // Always the top: centring would scroll past the first photos.
  return { scale, x, y: padding }
}

/**
 * Scale/translate so the world fits the viewport, within readable bounds.
 *
 * Suited to a single image or a bounded canvas. A photo wall should use
 * `fitWallTransform` instead; see the note there.
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

/**
 * Zoom bounds for the single-photo viewer, expressed as a multiplier of the
 * "fit in the window" scale.
 *
 * 1 is the whole photo visible. The upper bound is generous because the useful
 * ceiling depends on the photo: `viewerMaxZoomFor` narrows it to the point where
 * one image pixel maps to one screen pixel, beyond which zooming only blurs.
 */
export const VIEWER_MIN_ZOOM = 1
export const VIEWER_MAX_ZOOM = 8

/**
 * Lowest ceiling the viewer will offer.
 *
 * A photo smaller than its displayed size computes a 1:1 ratio below 1, which
 * would lock the viewer at "fit" with no way to zoom in at all. Offering a
 * little magnification is still useful for inspecting a small image, even if it
 * is technically interpolated.
 */
export const VIEWER_MIN_CEILING = 2

/**
 * Highest zoom that still shows real detail.
 *
 * Zooming past 1:1 stretches pixels without revealing anything, so the ceiling
 * is the ratio of source pixels to displayed pixels, capped by
 * `VIEWER_MAX_ZOOM` and floored by `VIEWER_MIN_CEILING`.
 *
 * @param naturalWidth   the photo's pixel width
 * @param displayedWidth the width the image occupies on screen when fitted
 * @param devicePixelRatio screen density; a 2x display needs twice the source
 *   pixels to look like 1:1, so it allows half the magnification
 */
export function viewerMaxZoom(naturalWidth: number, displayedWidth: number, devicePixelRatio = 1): number {
  if (!(naturalWidth > 0) || !(displayedWidth > 0) || !(devicePixelRatio > 0)) return VIEWER_MAX_ZOOM
  const oneToOne = naturalWidth / (displayedWidth * devicePixelRatio)
  return clamp(oneToOne, VIEWER_MIN_CEILING, VIEWER_MAX_ZOOM)
}

/**
 * Keep a panned/zoomed photo reachable.
 *
 * Without this, dragging far enough leaves the photo entirely off-screen with no
 * way back. Each axis is clamped so at least a quarter of the viewport's worth
 * of image stays inside; when the photo is smaller than the viewport on that
 * axis (zoomed out), it is centred instead.
 *
 * @param fitScale scale at which the photo exactly fills the viewport
 */
export function clampViewerTransform(
  t: Transform,
  viewportWidth: number,
  viewportHeight: number,
  fitScale: number
): Transform {
  if (!(fitScale > 0) || viewportWidth <= 0 || viewportHeight <= 0) return t

  const min = fitScale * VIEWER_MIN_ZOOM
  const max = fitScale * VIEWER_MAX_ZOOM
  const scale = clampScale(t.scale, min, max)

  // The photo's size at this scale, given that at `fitScale` it exactly fits.
  const width = (viewportWidth * scale) / fitScale
  const height = (viewportHeight * scale) / fitScale

  const axis = (value: number, viewport: number, size: number): number => {
    if (size <= viewport) {
      // Smaller than the viewport: pin to the centre. Panning it around would
      // only create empty space.
      return (viewport - size) / 2
    }
    // Larger than the viewport: keep the edges outside it, so no blank gap can
    // appear on either side. This is the same rule as any image viewer: you can
    // pan to the corners, never past them.
    return Math.min(Math.max(value, viewport - size), 0)
  }

  return { scale, x: axis(t.x, viewportWidth, width), y: axis(t.y, viewportHeight, height) }
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
