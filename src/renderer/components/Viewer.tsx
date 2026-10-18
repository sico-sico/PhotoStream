import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Photo } from '@shared/types'
import { formatIsoDate } from '@shared/i18n'
import {
  IDENTITY,
  clampViewerTransform,
  containSize,
  normalizeRotation,
  panBy,
  rotatedSize,
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
  const [transform, setTransform] = useState<Transform>(FIT_TRANSFORM)
  const [rotation, setRotation] = useState(0)
  const [dragging, setDragging] = useState(false)
  /** Non-null while two or more fingers are down. */
  const [pinching, setPinching] = useState(false)
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
   * The photo's on-screen size at fit, derived from its intrinsic ratio.
   *
   * This is set explicitly on the `<img>` rather than left to `object-fit`,
   * because `max-height: 100%` cannot resolve against a grid item whose height
   * is not definite: the element ended up 1552x1035 in a 1552x920 stage and the
   * photo overflowed, which made every pan bound wrong.
   */
  const fitted = useMemo(
    () => containSize(natural.width, natural.height, content.width, content.height),
    [content.height, content.width, natural.height, natural.width]
  )

  // Reset the swap state whenever the selected photo changes.
  useEffect(() => {
    setFullLoaded(false)
    setNatural({ width: 0, height: 0 })
  }, [photo.id])

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
      // Anchored at the stage centre, which is also the origin of `x`/`y`.
      update((previous) =>
        zoomViewerAbout(previous, previous.scale * factor, 0, 0, geometry.minZoom, geometry.maxZoom)
      )
    },
    [geometryFor, update]
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
      update((previous) =>
        zoomViewerAbout(previous, previous.scale * factor, pivot.x, pivot.y, geometry.minZoom, geometry.maxZoom)
      )
    }

    stage.addEventListener('wheel', handler, { passive: false })
    return () => stage.removeEventListener('wheel', handler)
  }, [geometryFor, update])

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
  const imageStyle = useMemo(() => {
    const parts: string[] = []
    if (transform.x !== 0 || transform.y !== 0) parts.push(`translate(${transform.x}px, ${transform.y}px)`)
    // The fit factor is folded into `scale` so the rendered size matches the box
    // `clampViewerTransform` uses for its bounds.
    const rendered = fitScale * transform.scale
    if (Math.abs(rendered - 1) > 0.0001) parts.push(`scale(${rendered})`)
    if (rotation !== 0) parts.push(`rotate(${rotation}deg)`)
    return parts.length > 0 ? { transform: parts.join(' ') } : undefined
  }, [fitScale, rotation, transform.x, transform.y, transform.scale])

  /**
   * Explicit layout size for the photo.
   *
   * Set in pixels rather than left to `object-fit` + `max-height`, which cannot
   * resolve against a grid item's indefinite height and let the photo overflow
   * the stage. Explicit dimensions keep the rendered box and the pan bounds
   * describing the same rectangle.
   */
  const sizeStyle = fitted.width > 0 ? { width: `${fitted.width}px`, height: `${fitted.height}px` } : undefined

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={photo.name} data-testid="viewer">
      {/*
        The stage and the details panel share a row so the photo stays visible
        while its settings are read; the panel takes width rather than covering
        the image.
      */}
      <div className="viewer-main">
        <div
          className={`viewer-stage ${transformed ? 'zoomed' : ''} ${dragging ? 'dragging' : ''} ${pinching ? 'pinching' : ''}`}
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
              className={`viewer-image preview ${fullLoaded ? 'hidden' : ''}`}
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
            src={`pic://photo/${encodeURIComponent(photo.name)}`}
            alt={photo.name}
            style={{ ...sizeStyle, ...imageStyle }}
            draggable={false}
            ref={imageRef}
            onLoad={(event) => {
              setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
              setFullLoaded(true)
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
