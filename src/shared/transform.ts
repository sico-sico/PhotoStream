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

/**
 * The smallest zoom at which a wall of this size can still fill the window.
 *
 * Zooming out reflows the wall so the columns keep filling the window: the layout
 * is computed for `viewportWidth / scale` world pixels, which keeps the *width*
 * covered at any zoom. Height is not compensated for — it follows from how many
 * rows the photos make, and a wider layout means fewer rows. Past a point the
 * scaled wall is shorter than the window, `clampWallTransform` centres it, and the
 * result is a thin band floating in empty space. Measured on the 3226-photo
 * library: at scale 0.05 the wall is 1600x329 inside a 1600x956 window.
 *
 * No layout can avoid this below a certain scale, because the wall's area is
 * fixed: scaling by `s` covers `area * s²` screen pixels, so covering the window
 * needs `s >= sqrt(windowArea / wallArea)`.
 *
 * This is only the *area* bound. The renderer also caps how many tiles it mounts,
 * which is a separate limit that depends on the actual layout; see
 * `minScaleForTiles`.
 */
export function minScaleForWall(
  worldWidth: number,
  worldHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  floor = MIN_SCALE
): number {
  if (!(worldWidth > 0) || !(worldHeight > 0)) return floor
  if (!(viewportWidth > 0) || !(viewportHeight > 0)) return floor
  const needed = Math.sqrt((viewportWidth * viewportHeight) / (worldWidth * worldHeight))
  // Capped at 1: a wall smaller than the window needs no zoom-out floor at all,
  // and a value above 1 would forbid zooming out (and break `fitToView`, which
  // legitimately scales below 1).
  return Math.min(1, Math.max(floor, needed))
}

/**
 * The smallest zoom at which every photo on screen still fits under the mount cap.
 *
 * The renderer keeps at most `maxTiles` tiles live and drops the rest, so zooming
 * out past the point where more tiles fit on screen makes photos disappear.
 * Measured on the 3226-photo library: 648 tiles intersected the viewport at scale
 * 0.18 and 2250 at 0.0965, against a cap of 600 — two thirds of the visible
 * photos were never rendered.
 *
 * Solved by bisection against the real layout rather than by a formula: the
 * visible count is not a smooth function of the scale, because the layout
 * re-flows into whole columns and rows. Eight steps resolve the range to well
 * under one percent.
 *
 * @param visibleAt count of tiles the cull would mount at a given scale
 */
export function minScaleForTiles(
  visibleAt: (scale: number) => number,
  maxTiles: number,
  floor = MIN_SCALE
): number {
  if (!(maxTiles > 0)) return floor
  // `floor` is the most zoomed-out this can ever be, so test it first: if even
  // that is within the cap there is nothing to raise.
  if (visibleAt(floor) <= maxTiles) return floor
  if (visibleAt(1) > maxTiles) return 1

  let low = floor
  let high = 1
  for (let i = 0; i < 8; i += 1) {
    const mid = (low + high) / 2
    if (visibleAt(mid) <= maxTiles) high = mid
    else low = mid
  }
  return high
}

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
 * Snap a rotation to the nearest quarter turn.
 *
 * The result is normalised into `[-180, 180]`, not `[0, 360)`: turning a photo
 * left once should read as -90° rather than 270°, and a half turn is shown as
 * 180° so the label stays symmetric.
 */
export function normalizeRotation(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0
  const snapped = Math.round(degrees / 90) * 90
  const wrapped = ((snapped % 360) + 360) % 360
  return wrapped > 180 ? wrapped - 360 : wrapped
}

/**
 * Axis-aligned size of a `width`x`height` box rotated by `rotation` degrees.
 *
 * A rotated photo is not the same rectangle: 90 degrees swaps width and height,
 * and 45 degrees grows both by up to `sqrt(2)`. Every pan/zoom bound has to be
 * derived from this box, or a rotated photo would either be draggable past its
 * own edge (revealing blank space) or refuse to reach a corner.
 */
export function rotatedSize(
  width: number,
  height: number,
  rotation: number
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 }
  const radians = ((rotation % 360) * Math.PI) / 180
  // Rounding leaves a quarter turn with 6e-17 instead of 0. Snapping keeps the
  // box exact, so a rotated photo pins to the edges like an unrotated one.
  const cos = Math.abs(Math.cos(radians))
  const sin = Math.abs(Math.sin(radians))
  const c = cos > 1 - 1e-12 ? 1 : cos < 1e-12 ? 0 : cos
  const s = sin > 1 - 1e-12 ? 1 : sin < 1e-12 ? 0 : sin
  return { width: width * c + height * s, height: width * s + height * c }
}

/**
 * Size an image occupies inside a box when letterboxed to preserve its aspect
 * ratio, i.e. what CSS `object-fit: contain` renders.
 *
 * The photo's *element* box is not its visible size: a grid item with
 * `max-width` can end up taller than its container, and `object-fit` then draws
 * the photo smaller than the box. Bounds computed from the box would shrink a
 * photo that already fits, so every measurement goes through this instead.
 */
export function containSize(
  naturalWidth: number,
  naturalHeight: number,
  boxWidth: number,
  boxHeight: number
): { width: number; height: number } {
  if (!(naturalWidth > 0) || !(naturalHeight > 0) || !(boxWidth > 0) || !(boxHeight > 0)) {
    return { width: 0, height: 0 }
  }
  const ratio = Math.min(boxWidth / naturalWidth, boxHeight / naturalHeight)
  return { width: naturalWidth * ratio, height: naturalHeight * ratio }
}

/** What the viewer knows about the stage and the photo it is showing. */
export interface ViewerMetrics {
  viewportWidth: number
  viewportHeight: number
  /** Size the photo actually occupies on screen when fitted, before rotation. */
  imageWidth: number
  imageHeight: number
  /** Clockwise rotation in degrees. */
  rotation: number
}

export interface ViewerGeometry extends ViewerMetrics {
  /** Scale bounds, as a multiple of "fit". `1` shows the whole photo. */
  minZoom: number
  maxZoom: number
}

/**
 * Extra scale needed so a rotated photo stays inside the stage.
 *
 * The photo is already fitted *unrotated*, so a landscape photo turned upright
 * overflows vertically. There is also no reason to scale a photo *up* once it is
 * rotated: that would silently zoom on a control the user pressed for
 * orientation. The factor is therefore capped at 1.
 *
 * Both `imageWidth`/`imageHeight` and the viewport must describe the same
 * coordinate space, so pass the letterboxed photo size and the stage's content
 * area (padding already subtracted).
 */
export function viewerFitScale(metrics: ViewerMetrics): number {
  const rotated = rotatedSize(metrics.imageWidth, metrics.imageHeight, metrics.rotation)
  if (!(rotated.width > 0) || !(rotated.height > 0)) return 1
  if (!(metrics.viewportWidth > 0) || !(metrics.viewportHeight > 0)) return 1
  return Math.min(1, metrics.viewportWidth / rotated.width, metrics.viewportHeight / rotated.height)
}

/**
 * Keep a panned/zoomed/rotated photo reachable and gap-free.
 *
 * `x` and `y` are offsets of the photo's centre from the stage's centre, which
 * is how CSS `transform: translate(...) scale(...) rotate(...)` lays it out.
 *
 * Once the photo is larger than the stage on an axis, its edges are kept
 * outside the stage: you can pan to a corner, never past it, so no blank gap can
 * ever appear. When it is smaller than the stage on an axis it is centred there
 * instead, because panning it would only create empty space.
 */
export function clampViewerTransform(t: Transform, geometry: ViewerGeometry): Transform {
  if (!(geometry.viewportWidth > 0) || !(geometry.viewportHeight > 0)) return t

  const scale = clamp(t.scale, geometry.minZoom, geometry.maxZoom)
  const rotated = rotatedSize(geometry.imageWidth, geometry.imageHeight, geometry.rotation)
  // Still decoding: there is no box to clamp against yet.
  if (!(rotated.width > 0) || !(rotated.height > 0)) return { ...t, scale }

  const fit = viewerFitScale(geometry)
  const boxWidth = rotated.width * fit * scale
  const boxHeight = rotated.height * fit * scale

  const axis = (value: number, viewport: number, size: number): number => {
    if (size <= viewport) return 0
    const slack = (size - viewport) / 2
    return clamp(value, -slack, slack)
  }

  return {
    scale,
    x: axis(t.x, geometry.viewportWidth, boxWidth),
    y: axis(t.y, geometry.viewportHeight, boxHeight)
  }
}

/**
 * Keep the wall inside its own bounds.
 *
 * The wall is a finite canvas, not an endless plane: it has a width and height
 * computed from the photos. Without this clamp, dragging reveals empty space
 * beyond the edge, which reads as a bug rather than as dragging.
 *
 * The rule is the same one the viewer uses, and it is what makes four-way
 * dragging feel right:
 * - when the wall is **larger** than the viewport on an axis, its edge is not
 *   allowed to come inside the viewport, so you can pan to the last row or
 *   column but never past it;
 * - when it is **smaller**, that axis is centred and cannot be panned at all,
 *   because there is nothing out of view to reach.
 *
 * @param worldWidth  the wall's laid-out width in world units
 * @param worldHeight the wall's laid-out height in world units
 */
export function clampWallTransform(
  t: Transform,
  worldWidth: number,
  worldHeight: number,
  viewportWidth: number,
  viewportHeight: number
): Transform {
  if (!(viewportWidth > 0) || !(viewportHeight > 0)) return t
  if (!(worldWidth > 0) || !(worldHeight > 0)) return t

  const scale = t.scale > 0 ? t.scale : 1

  const axis = (value: number, viewport: number, world: number): number => {
    const scaled = world * scale
    if (scaled <= viewport) {
      // Smaller than the window: centre it. Panning would only add empty space.
      return (viewport - scaled) / 2
    }
    // Larger: the far edge must not come inside the viewport, and the near edge
    // must not pass the origin.
    return clamp(value, viewport - scaled, 0)
  }

  return {
    scale: t.scale,
    x: axis(t.x, viewportWidth, worldWidth),
    y: axis(t.y, viewportHeight, worldHeight)
  }
}

/**
 * Zoom to `nextScale` while keeping the stage point under (`pivotX`, `pivotY`)
 * pinned there.
 *
 * Works on centre-offset coordinates: a point at stage position `p` sits at
 * `p = centre + offset`, so holding it fixed means scaling the offset relative
 * to the pivot. This is what makes wheel and pinch zoom feel anchored to the
 * cursor or to the fingers rather than to the middle of the window.
 */
export function zoomViewerAbout(
  t: Transform,
  nextScale: number,
  pivotX: number,
  pivotY: number,
  minZoom: number,
  maxZoom: number
): Transform {
  const scale = clamp(nextScale, minZoom, maxZoom)
  if (scale === t.scale || !(t.scale > 0)) return { ...t, scale }
  const ratio = scale / t.scale
  return {
    scale,
    x: pivotX - (pivotX - t.x) * ratio,
    y: pivotY - (pivotY - t.y) * ratio
  }
}

/** Visible world rectangle for a viewport, used for culling and LOD decisions. */export function visibleWorldRect(
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
