import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Photo, ThumbLevel } from '@shared/types'
import { pickThumbLevel, viewerEdge } from '@shared/thumbs'
import { formatIsoDate } from '@shared/i18n'
import {
  IDENTITY,
  clampViewerTransform,
  containSize,
  normalizeRotation,
  panBy,
  rotatedSize,
  snapToDevicePixel,
  viewerFitScale,
  viewerMaxZoom,
  zoomViewerAbout,
  type Transform,
  type ViewerMetrics
} from '@shared/transform'
import { beginPinch, isPinch, midpoint, pinchScale, type PinchPoint, type PinchStart } from '@shared/pinch'
import type { RawExif } from '@shared/exif'
import { useI18n } from '../i18n/context'
import { InfoPanel } from './InfoPanel'

export interface ViewerProps {
  photo: Photo
  /** Cached thumbnail URL, shown immediately while the original decodes. */
  previewUrl: string | undefined
  onClose: () => void
  onPrev: () => void
  onNext: () => void
  onReveal: () => void
  /**
   * Whether the EXIF panel is shown.
   *
   * Owned by the wall so the choice can be remembered and persisted: the panel
   * describes *how the user wants to browse*, so it has to survive stepping to
   * the next photo, closing the viewer and restarting the app. Opening one file
   * from outside the app turns it on, because in that case the file's details
   * are as much of the answer as the picture.
   */
  infoOpen?: boolean
  /** Called when the user opens or closes the panel, so the choice can be kept. */
  onInfoOpenChange?: (open: boolean) => void
}

/** Identity transform meaning "the photo exactly fits the stage". */
export const FIT_TRANSFORM: Transform = { ...IDENTITY }

/** Wheel sensitivity, shared by the wheel and pinch handlers so they feel alike. */
const WHEEL_SPEED = 0.0018

/** Convert a client point into the stage's centre-offset coordinates. */
function toStagePoint(stage: HTMLElement, clientX: number, clientY: number): PinchPoint {
  const rect = stage.getBoundingClientRect()
  return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 }
}

/**
 * Single-photo viewer with zoom, pan, rotation and two-finger pinch.
 *
 * The image is laid out at "fit" size by CSS and then transformed, so an
 * unscaled photo costs nothing extra. `x` and `y` are offsets of the photo's
 * centre from the stage centre; `rotation` is a clockwise quarter turn.
 *
 * `clampViewerTransform` derives its bounds from the *rotated* bounding box, so
 * a landscape photo turned upright still pins to the stage edges instead of
 * exposing a gap, and the photo can never be dragged out of reach.
 *
 * A 51 MB / 7952x5304 JPEG takes ~0.55 s to decode, so the cached thumbnail is
 * shown first and the original swapped in when it is ready. That removes the
 * white flash without an explicit loading spinner.
 */
export function Viewer({
  photo,
  previewUrl,
  onClose,
  onPrev,
  onNext,
  onReveal,
  infoOpen = false,
  onInfoOpenChange
}: ViewerProps): React.JSX.Element {
  const { t, locale } = useI18n()
  const [fullLoaded, setFullLoaded] = useState(false)
  /**
   * The resolved rendition, tagged with the photo it belongs to.
   *
   * Zooming in switches tiers (`zoom` then `full`), and each switch is an IPC
   * round trip while the main process encodes or locates the file. Clearing the
   * URL on every tier change would blank the photo for that gap; keeping the
   * previous one is safe because it is the same picture, just coarser. The tag
   * is what makes it safe across a photo change: a stale URL from the previous
   * photo must never be drawn.
   */
  const [rendition, setRendition] = useState<{ photoId: string; url: string } | null>(null)
  const [fullFailed, setFullFailed] = useState(false)
  /**
   * Set when the chosen rendition could not be produced.
   *
   * A failed rendition must not leave the viewer on the coarse preview: that is
   * exactly what "blurry next to the system viewer" looks like (a 512px bitmap
   * stretched over the stage measures ~4x softer than a sharp one). Asking for
   * the original costs a bigger download but is the highest resolution the app
   * can possibly show, so it is the right fallback.
   */
  const [forceFull, setForceFull] = useState(false)
  const [transform, setTransform] = useState<Transform>(FIT_TRANSFORM)
  const [rotation, setRotation] = useState(0)
  const [dragging, setDragging] = useState(false)
  /** Non-null while two or more fingers are down. */
  const [pinching, setPinching] = useState(false)
  /**
   * True for a moment after a zoom step.
   *
   * The photo is only composited while it is moving (see the `will-change` rules
   * in `styles.css`); a wheel or trackpad zoom has no pointer-down to mark its
   * end, so it holds the layer briefly and then releases it. `will-change` is
   * absent at rest, which is what lets Chromium paint the bitmap at full
   * sharpness instead of scaling a rasterised layer.
   */
  const [zooming, setZooming] = useState(false)
  const zoomTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const holdCompositeLayer = useCallback(() => {
    setZooming(true)
    if (zoomTimer.current) clearTimeout(zoomTimer.current)
    zoomTimer.current = setTimeout(() => {
      zoomTimer.current = null
      setZooming(false)
    }, 220)
  }, [])
  /** `null` until the read finishes; `{}` when the file carries no EXIF. */
  const [exif, setExif] = useState<RawExif | null>(null)

  const stageRef = useRef<HTMLDivElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  /** The stage's content box, kept in sync by a ResizeObserver. */
  const [content, setContent] = useState({ width: 0, height: 0 })
  /** The photo's intrinsic size, known once it decodes. */
  const [natural, setNatural] = useState({ width: 0, height: 0 })
  const drag = useRef<{ pointerId: number; lastX: number; lastY: number; moved: boolean } | null>(null)
  /** Live pointers, keyed by id, in stage-local centre-offset coordinates. */
  const pointers = useRef(new Map<number, PinchPoint>())
  const pinch = useRef<PinchStart | null>(null)
  const pinchScaleRef = useRef(1)
  /**
   * Ceiling for this photo: past 1:1 there is no more detail to reveal.
   * Recomputed on load because it depends on the image's pixel size.
   */
  const maxZoom = useRef(4)

  /**
   * Device pixels per CSS pixel.
   *
   * 1.5 on a 4K screen at the 150% scaling Windows recommends, which is exactly
   * the case where a ratio-derived CSS size falls between device pixels and
   * Chromium has to resample the bitmap. Every geometric value the viewer paints
   * is snapped to this grid.
   */
  const dpr =
    typeof window.devicePixelRatio === 'number' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1

  /**
   * The photo's on-screen size at fit, derived from its intrinsic ratio.
   *
   * This is set explicitly on the `<img>` rather than left to `object-fit`,
   * because `max-height: 100%` cannot resolve against a grid item whose height
   * is not definite: the element ended up 1552x1035 in a 1552x920 stage and the
   * photo overflowed, which made every pan bound wrong.
   *
   * Rounded onto the device-pixel grid: at 150% display scaling a fitted size
   * like 1227.385 CSS px is 1841.078 device pixels, and the 0.078 makes
   * Chromium resample the bitmap at fit as well as at zoom. See
   * `snapToDevicePixel`.
   */
  const fitted = useMemo(() => {
    const size = containSize(natural.width, natural.height, content.width, content.height)
    return {
      width: snapToDevicePixel(size.width, dpr),
      height: snapToDevicePixel(size.height, dpr)
    }
  }, [content.height, content.width, dpr, natural.height, natural.width])

  // The scan already parsed every photo's dimensions, so `natural` can come from
  // the photo rather than waiting for the image to decode. That keeps `fitted`
  // and the 1:1 zoom ceiling stable while the rendition swaps (`zoom` -> `full`
  // when zooming in), instead of jumping each time a differently-sized bitmap
  // loads.
  useEffect(() => {
    setNatural(
      photo.width > 0 && photo.height > 0
        ? { width: photo.width, height: photo.height }
        : { width: 0, height: 0 }
    )
    setFullLoaded(false)
    setFullFailed(false)
    setForceFull(false)
  }, [photo.id])

  /**
   * Which rendition Chromium should draw.
   *
   * Two things matter here and they are not the same question:
   *
   * 1. How many device pixels the photo occupies. That is the size the bitmap
   *    should be generated at — a larger one is downscaled again during paint,
   *    and that second resample is what made the viewer look soft next to the
   *    system viewer. Measured on an 8064x6048 photo shown at 1840 device px:
   *    the 2560 `zoom` tier scored 21.35 gradient energy, a rendition generated
   *    at 1840 scored 24.33, and an ideal Lanczos reference 24.64.
   * 2. Whether the zoom has outgrown the largest generated size. Past that the
   *    original is streamed, because generating a bigger intermediate would only
   *    add another downscale.
   *
   * `viewerEdge` answers (1) and returns `null` past the ceiling; the fallback
   * then picks between `zoom` and `full` as the wall does.
   */
  const devicePx = useMemo(() => {
    if (fitted.width <= 0) return 0
    return Math.max(fitted.width, fitted.height) * transform.scale * dpr
  }, [fitted.width, fitted.height, transform.scale, dpr])
  const edge = viewerEdge(devicePx)
  const level = useMemo<ThumbLevel>(() => {
    if (fitted.width <= 0 || fitted.height <= 0) return 'zoom'
    if (edge !== null) return 'zoom'
    return pickThumbLevel(Math.max(fitted.width, fitted.height), transform.scale, dpr)
  }, [fitted.width, fitted.height, transform.scale, dpr, edge])

  /** The tier actually requested: a failed lower tier falls back to the original. */
  const effectiveLevel: ThumbLevel = forceFull ? 'full' : level
  /** Only ask for a sized rendition when the tier is a generated one. */
  const effectiveEdge = effectiveLevel === 'full' ? undefined : (edge ?? undefined)

  // Resolve the rendition URL in the main process. It knows the library root and
  // can preserve subdirectory paths without exposing absolute paths to the
  // renderer. Using only `photo.name` breaks recursive libraries and leaves the
  // blurred preview visible after the original request returns 404.
  //
  // Dependencies are the primitives the main process actually reads, not the
  // `photo` object: a parent that rebuilds the object each render would other-
  // wise trigger an IPC call per render.
  useEffect(() => {
    let cancelled = false
    void window.photoStream
      .thumbUrl(photo, effectiveLevel, effectiveEdge)
      .then((url) => {
        if (!cancelled) setRendition({ photoId: photo.id, url })
      })
      .catch(() => {
        if (cancelled) return
        if (effectiveLevel !== 'full') setForceFull(true)
        else setFullFailed(true)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo.id, photo.path, photo.width, photo.height, effectiveLevel, effectiveEdge])

  /**
   * Read the EXIF details only while the panel is open.
   *
   * The read is per-photo and costs a full metadata parse, so it is deferred
   * until asked for; the panel also re-reads when stepping to the next photo so
   * the values never describe the previous one.
   */
  useEffect(() => {
    if (!infoOpen) return
    let cancelled = false
    setExif(null)
    void window.photoStream
      .photoExif(photo.path)
      .then((result) => {
        if (!cancelled) setExif(result ?? {})
      })
      .catch(() => {
        // An unreadable file still shows the file-level rows rather than an
        // empty panel.
        if (!cancelled) setExif({})
      })
    return () => {
      cancelled = true
    }
  }, [infoOpen, photo.id, photo.path])

  // Each photo starts fitted and upright: carrying a zoom across a photo change
  // disorients, and a rotation belongs to the photo it was applied to.
  useEffect(() => {
    setTransform(FIT_TRANSFORM)
    setRotation(0)
  }, [photo.id])

  /**
   * Toggle the panel and report it, so the choice outlives this photo.
   *
   * A plain `setInfoOpen` would keep the state local to the viewer, and the
   * viewer is not remounted between photos — but the wall also needs to know, or
   * the preference cannot be persisted and the panel closes again on the next
   * photo or the next launch.
   */
  const toggleInfo = useCallback(
    (next?: boolean) => {
      onInfoOpenChange?.(next ?? !infoOpen)
    },
    [infoOpen, onInfoOpenChange]
  )

  /** Everything the bounds depend on, in the stage's content box. */
  const geometryFor = useCallback(
    (nextRotation = rotation): ViewerMetrics & { minZoom: number; maxZoom: number } => ({
      viewportWidth: content.width,
      viewportHeight: content.height,
      imageWidth: fitted.width,
      imageHeight: fitted.height,
      rotation: nextRotation,
      minZoom: 1,
      maxZoom: maxZoom.current
    }),
    [content.height, content.width, fitted.height, fitted.width, rotation]
  )
  /** Apply a transform, clamped so the photo stays reachable and gap-free. */
  const update = useCallback(
    (next: (previous: Transform) => Transform) => {
      const geometry = geometryFor()
      setTransform((previous) => clampViewerTransform(next(previous), geometry))
    },
    [geometryFor]
  )

  /**
   * Rotate by a quarter turn and re-clamp immediately.
   *
   * The bounds change with the rotation, so a photo rotated while panned to an
   * edge would otherwise sit outside the stage until the next gesture.
   */
  const rotateBy = useCallback(
    (degrees: number) => {
      setRotation((previousRotation) => {
        const nextRotation = normalizeRotation(previousRotation + degrees)
        const geometry = geometryFor(nextRotation)
        setTransform((previous) => clampViewerTransform(previous, geometry))
        return nextRotation
      })
    },
    [geometryFor]
  )

  const reset = useCallback(() => {
    setTransform(FIT_TRANSFORM)
    setRotation(0)
  }, [])

  /**
   * Track the stage's content box.
   *
   * Measured in an effect rather than during render: a layout read inside render
   * would force a synchronous reflow on every wheel event.
   */
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const measure = (): void => {
      const rect = stage.getBoundingClientRect()
      const style = window.getComputedStyle(stage)
      setContent({
        width: Math.max(0, rect.width - (parseFloat(style.paddingLeft) + parseFloat(style.paddingRight))),
        height: Math.max(0, rect.height - (parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)))
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  // A pending zoom timer must not fire after the viewer is gone.
  useEffect(
    () => () => {
      if (zoomTimer.current) clearTimeout(zoomTimer.current)
    },
    []
  )

  /**
   * How much a rotation has to shrink the photo so it still fits the stage.
   *
   * Rotating refits on purpose: leaving the photo at its old scale would push
   * part of it off screen the moment the user turns a landscape photo upright,
   * and they would have to zoom out manually to see what they just rotated.
   */
  const fitScale = useMemo(() => {
    if (!(fitted.width > 0)) return 1
    return viewerFitScale({
      viewportWidth: content.width,
      viewportHeight: content.height,
      imageWidth: fitted.width,
      imageHeight: fitted.height,
      rotation
    })
  }, [content.height, content.width, fitted.height, fitted.width, rotation])

  /**
   * Ceiling for the current rotation, in units of the fit scale.
   *
   * Both sides are measured through the same rotation: a portrait-oriented photo
   * has its long side on the vertical axis, so comparing the unrotated width to
   * the rotated display width would understate the available magnification and
   * stop the user short of 1:1.
   */
  useEffect(() => {
    const naturalBox = rotatedSize(natural.width, natural.height, rotation)
    const shownBox = rotatedSize(fitted.width * fitScale, fitted.height * fitScale, rotation)
    maxZoom.current = viewerMaxZoom(naturalBox.width, shownBox.width, window.devicePixelRatio || 1)
  }, [fitScale, fitted.height, fitted.width, natural.height, natural.width, rotation])

  const zoomByFactor = useCallback(
    (factor: number) => {
      const geometry = geometryFor()
      holdCompositeLayer()
      // Anchored at the stage centre, which is also the origin of `x`/`y`.
      update((previous) =>
        zoomViewerAbout(previous, previous.scale * factor, 0, 0, geometry.minZoom, geometry.maxZoom)
      )
    },
    [geometryFor, holdCompositeLayer, update]
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowLeft') onPrev()
      else if (event.key === 'ArrowRight') onNext()
      else if (event.key === '0') reset()
      else if (event.key === '+' || event.key === '=') zoomByFactor(1.25)
      else if (event.key === '-' || event.key === '_') zoomByFactor(1 / 1.25)
      else if (event.key === 'r' || event.key === 'R' || event.key === ']') rotateBy(90)
      else if (event.key === '[') rotateBy(-90)
      else if (event.key === 'i' || event.key === 'I') toggleInfo()
      else return
      // Only swallow the keys the viewer actually handled.
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onNext, onPrev, reset, rotateBy, toggleInfo, zoomByFactor])

  // A non-passive listener is required: React's synthetic wheel handler cannot
  // `preventDefault`, and the wall behind the overlay would scroll instead.
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return

    const handler = (event: WheelEvent): void => {
      // The wall listens for wheel on `window`, so without this the photo behind
      // the overlay would zoom at the same time and end up scrolled out of view
      // by the time the viewer closes.
      event.preventDefault()
      event.stopPropagation()
      const geometry = geometryFor()
      // A trackpad pinch arrives as ctrl+wheel with tiny deltas, so it needs a
      // steeper response or the gesture feels dead next to a scroll wheel.
      const speed = event.ctrlKey ? WHEEL_SPEED * 4 : WHEEL_SPEED
      const unit = event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? 800 : 1
      const pivot = toStagePoint(stage, event.clientX, event.clientY)
      const factor = Math.exp(-event.deltaY * unit * speed)
      holdCompositeLayer()
      update((previous) =>
        zoomViewerAbout(previous, previous.scale * factor, pivot.x, pivot.y, geometry.minZoom, geometry.maxZoom)
      )
    }

    stage.addEventListener('wheel', handler, { passive: false })
    return () => stage.removeEventListener('wheel', handler)
  }, [geometryFor, holdCompositeLayer, update])

  const onPointerDown = (event: React.PointerEvent): void => {
    if (event.button !== 0) return
    const stage = stageRef.current
    if (!stage) return

    // Capture keeps the pan alive when the cursor leaves the stage. It throws for
    // a pointer the browser no longer considers active (a synthetic event in a
    // test, or a pointer released between frames), and losing the gesture over
    // that would be far worse than losing the capture.
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    } catch {
      // Not capturable; panning still works while the cursor stays inside.
    }
    pointers.current.set(event.pointerId, toStagePoint(stage, event.clientX, event.clientY))

    if (isPinch(pointers.current.size)) {
      const [a, b] = [...pointers.current.values()]
      // A second finger cancels the pan: reading it as a drag would teleport the
      // photo by the distance between the two pointers.
      drag.current = null
      pinch.current = beginPinch(a, b)
      pinchScaleRef.current = 1
      setPinching(true)
      setDragging(false)
      return
    }

    drag.current = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY, moved: false }
  }

  const onPointerMove = (event: React.PointerEvent): void => {
    const stage = stageRef.current
    if (!stage) return

    if (pointers.current.has(event.pointerId)) {
      pointers.current.set(event.pointerId, toStagePoint(stage, event.clientX, event.clientY))
    }

    // Pinch takes precedence over pan for the whole gesture.
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()]
      const factor = pinchScale(pinch.current, a, b)
      // Compare against the last frame, not the start, so the zoom tracks the
      // fingers continuously instead of only when they stop moving.
      const step = factor / pinchScaleRef.current
      pinchScaleRef.current = factor
      if (!Number.isFinite(step) || step <= 0) return

      const geometry = geometryFor()
      const mid = midpoint(a, b)
      update((previous) =>
        zoomViewerAbout(previous, previous.scale * step, mid.x, mid.y, geometry.minZoom, geometry.maxZoom)
      )
      return
    }

    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    const dx = event.clientX - current.lastX
    const dy = event.clientY - current.lastY
    if (dx === 0 && dy === 0) return

    current.lastX = event.clientX
    current.lastY = event.clientY
    // Past a couple of pixels this is a drag, not a click on the backdrop.
    if (Math.abs(dx) + Math.abs(dy) > 2) current.moved = true
    setDragging(true)
    update((previous) => panBy(previous, dx, dy))
  }

  const endGesture = (event: React.PointerEvent, cancelled = false): void => {
    pointers.current.delete(event.pointerId)
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    } catch {
      // The pointer was never captured, or is already gone.
    }

    if (pinch.current) {
      // Lifting one of two fingers ends the pinch instead of starting a pan from
      // the remaining one, which would otherwise jerk the photo.
      if (!isPinch(pointers.current.size)) {
        pinch.current = null
        pinchScaleRef.current = 1
        setPinching(false)
      }
      return
    }

    const current = drag.current
    drag.current = null
    setDragging(false)
    if (!current || current.pointerId !== event.pointerId) return
    // Only a click that did not move closes the viewer.
    if (!cancelled && !current.moved) onClose()
  }

  const zoomed = Math.abs(transform.scale - 1) > 0.001
  const transformed = zoomed || rotation !== 0 || fitScale !== 1
  /**
   * The size the photo is actually painted at, in CSS pixels.
   *
   * This is a layout size, not a `transform: scale()` factor, and that is the
   * whole point. A scaled `<img>` is rasterised into a texture at its layout
   * size and then filtered by the GPU, whose only tool is bilinear: measured at
   * 1:1 on a 4K screen at 150% scaling, a transform-scaled original scored 17.62
   * gradient energy where the same pixels laid out at their final size scored
   * 18.16 against a 18.19 reference. Laying the photo out is the difference
   * between 91% and 100% of the sharpness of the untouched file.
   *
   * Rounded onto the device-pixel grid for the same reason: at 150% scaling a
   * ratio-derived size lands between device pixels, and the resulting resample
   * softens the photo and adds jaggies.
   */
  const painted = useMemo(() => {
    const scale = fitScale * transform.scale
    if (!(fitted.width > 0) || !(fitted.height > 0)) return { width: 0, height: 0, scale }
    return {
      width: snapToDevicePixel(fitted.width * scale, dpr),
      height: snapToDevicePixel(fitted.height * scale, dpr),
      scale
    }
  }, [dpr, fitScale, fitted.height, fitted.width, transform.scale])

  /**
   * The inline transform: a translation, plus a rotation when the user asked for
   * one. Scaling never happens here — the size is already in `sizeStyle`.
   *
   * The offset is derived rather than snapped directly. The element is a centred
   * grid item, so its painted left edge sits at `(viewport - painted) / 2 + x`;
   * snapping *that* expression and solving back for `x` removes the half pixel
   * the centring contributes. `x` itself is left alone because
   * `clampViewerTransform` bounds the pan with it.
   *
   * At fit the transform stays empty: the photo is downscaled from its rendition
   * there anyway, and a stray `translate(0.5px, 0.5px)` would only break the
   * "nothing has been done yet" state.
   */
  const imageStyle = useMemo(() => {
    const parts: string[] = []
    // Keyed on the user's zoom, not on the painted ratio: the fit box is snapped
    // to the device grid, so `fitScale` can come out a hair below 1 and would
    // otherwise emit a visible half-pixel correction in the resting state.
    const aligned = Math.abs(transform.scale - 1) > 0.0001
    const offset = (value: number, side: number, viewport: number): number => {
      if (!aligned || !(side > 0) || !(viewport > 0)) return value
      const baseline = (viewport - side) / 2
      return snapToDevicePixel(baseline + value, dpr) - baseline
    }
    const tx = offset(transform.x, painted.width, content.width)
    const ty = offset(transform.y, painted.height, content.height)
    // Rounding two algebraically identical expressions leaves dust like
    // -1.4e-14, which CSS rejects: the whole transform would be dropped and the
    // photo would silently fall back to the soft path.
    const clean = (value: number): number => Number(value.toFixed(9))
    const [cx, cy] = [clean(tx), clean(ty)]
    if (cx !== 0 || cy !== 0) parts.push(`translate(${cx}px, ${cy}px)`)
    if (rotation !== 0) parts.push(`rotate(${rotation}deg)`)
    return parts.length > 0 ? { transform: parts.join(' ') } : undefined
  }, [content.height, content.width, dpr, painted.height, painted.width, rotation, transform.x, transform.y, transform.scale])

  /**
   * Layout size for the photo: the painted size computed above, not the fit box.
   *
   * Set in pixels rather than left to `object-fit` + `max-height`, which cannot
   * resolve against a grid item's indefinite height and let the photo overflow
   * the stage. Explicit dimensions keep the rendered box and the pan bounds
   * describing the same rectangle.
   */
  const sizeStyle =
    painted.width > 0 ? { width: `${painted.width}px`, height: `${painted.height}px` } : undefined

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={photo.name} data-testid="viewer">
      {/*
        The stage and the details panel share a row so the photo stays visible
        while its settings are read; the panel takes width rather than covering
        the image.
      */}
      <div className="viewer-main">
        <div
          className={`viewer-stage ${transformed ? 'zoomed' : ''} ${dragging ? 'dragging' : ''} ${pinching ? 'pinching' : ''} ${zooming ? 'zooming' : ''}`}
          ref={stageRef}
          data-testid="viewer-stage"
          style={transformed ? { touchAction: 'none' } : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(event) => endGesture(event)}
          onPointerCancel={(event) => endGesture(event, true)}
          onDoubleClick={reset}
        >
          {previewUrl ? (
            <img
              className={`viewer-image preview ${fullLoaded ? 'hidden' : ''} ${fullFailed ? 'failed' : ''}`}
              src={previewUrl}
              alt=""
              aria-hidden="true"
              style={{ ...sizeStyle, ...imageStyle }}
              draggable={false}
            />
          ) : null}
          <img
            className={`viewer-image ${fullLoaded ? 'ready' : ''}`}
            data-testid="viewer-image"
            src={rendition && rendition.photoId === photo.id ? rendition.url : undefined}
            alt={photo.name}
            style={{ ...sizeStyle, ...imageStyle }}
            draggable={false}
            ref={imageRef}
            onLoad={(event) => {
              setFullLoaded(true)
              setFullFailed(false)
              // Fallback when the scan could not read the source dimensions.
              setNatural((prev) =>
                prev.width > 0
                  ? prev
                  : { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }
              )
            }}
            onError={() => {
              // A broken lower tier escalates to the original; only a broken
              // original leaves the (unblurred) preview as the best available.
              if (effectiveLevel !== 'full') setForceFull(true)
              else setFullFailed(true)
            }}
          />
        </div>

        {infoOpen ? <InfoPanel photo={photo} exif={exif} onClose={() => toggleInfo(false)} /> : null}
      </div>

      <div className="viewer-bar">
        <button type="button" className="button ghost" onClick={onPrev} aria-label={t('viewer.prev')}>
          ←
        </button>
        <div className="viewer-meta">
          <strong dir="auto">{photo.name}</strong>
          <span>
            {photo.takenAt ? formatIsoDate(locale, photo.takenAt) : t('viewer.noDate')}
            {photo.width > 0 ? ` · ${t('viewer.size', { width: photo.width, height: photo.height })}` : ''}
            {zoomed ? ` · ${Math.round(transform.scale * 100)}%` : ''}
            {rotation !== 0 ? ` · ${rotation}°` : ''}
          </span>
        </div>
        <button
          type="button"
          className={`button ghost ${infoOpen ? 'active' : ''}`}
          onClick={() => toggleInfo()}
          aria-label={infoOpen ? t('viewer.hideInfo') : t('viewer.info')}
          aria-expanded={infoOpen}
          title={`${infoOpen ? t('viewer.hideInfo') : t('viewer.info')} (I)`}
        >
          ⓘ
        </button>
        <button
          type="button"
          className="button ghost"
          onClick={() => rotateBy(-90)}
          aria-label={t('viewer.rotateLeft')}
          title={`${t('viewer.rotateLeft')} ([)`}
        >
          ↺
        </button>
        <button
          type="button"
          className="button ghost"
          onClick={() => rotateBy(90)}
          aria-label={t('viewer.rotateRight')}
          title={`${t('viewer.rotateRight')} (R)`}
        >
          ↻
        </button>
        <button
          type="button"
          className="button ghost"
          onClick={reset}
          disabled={!transformed}
          aria-label={t('viewer.fit')}
          title={`${t('viewer.fit')} (0)`}
        >
          {t('viewer.fit')}
        </button>
        <button type="button" className="button ghost" onClick={onReveal}>
          {t('viewer.reveal')}
        </button>
        <button type="button" className="button ghost" onClick={onNext} aria-label={t('viewer.next')}>
          →
        </button>
        <button type="button" className="button" onClick={onClose} aria-label={t('viewer.close')}>
          ✕
        </button>
      </div>
    </div>
  )
}
