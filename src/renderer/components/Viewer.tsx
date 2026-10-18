import { useCallback, useEffect, useRef, useState } from 'react'
import type { Photo } from '@shared/types'
import { formatIsoDate } from '@shared/i18n'
import { VIEWER_MIN_ZOOM, clampViewerTransform, panBy, viewerMaxZoom, zoomByWheel, type Transform } from '@shared/transform'
import { useI18n } from '../i18n/context'

export interface ViewerProps {
  photo: Photo
  /** Cached thumbnail URL, shown immediately while the original decodes. */
  previewUrl: string | undefined
  onClose: () => void
  onPrev: () => void
  onNext: () => void
  onReveal: () => void
}

/** Identity transform meaning "the photo exactly fits the stage". */
export const FIT_TRANSFORM: Transform = { scale: 1, x: 0, y: 0 }

/**
 * Single-photo viewer with zoom and pan.
 *
 * The image is laid out at "fit" size by CSS and then transformed, so an
 * unscaled photo costs nothing extra. Wheel zooms around the cursor; drag pans.
 * `clampViewerTransform` keeps part of the photo on screen, so it can never be
 * dragged out of reach and lost.
 *
 * A 51 MB / 7952x5304 JPEG takes ~0.55 s to decode, so the cached thumbnail is
 * shown first and the original swapped in when it is ready. That removes the
 * white flash without an explicit loading spinner.
 */
export function Viewer({ photo, previewUrl, onClose, onPrev, onNext, onReveal }: ViewerProps): React.JSX.Element {
  const { t, locale } = useI18n()
  const [fullLoaded, setFullLoaded] = useState(false)
  const [transform, setTransform] = useState<Transform>(FIT_TRANSFORM)
  const [dragging, setDragging] = useState(false)

  const stageRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ pointerId: number; lastX: number; lastY: number; moved: boolean } | null>(null)
  /**
   * Ceiling for this photo: past 1:1 there is no more detail to reveal.
   * Recomputed on load because it depends on the image's pixel size.
   */
  const maxZoom = useRef(4)

  const recomputeMaxZoom = useCallback((image: HTMLImageElement) => {
    // `offsetWidth` ignores CSS transforms, so it is the fitted width.
    const displayedWidth = image.offsetWidth
    maxZoom.current = viewerMaxZoom(image.naturalWidth, displayedWidth, window.devicePixelRatio || 1)
  }, [])

  // Reset the swap state whenever the selected photo changes.
  useEffect(() => {
    setFullLoaded(false)
  }, [photo.id])

  // Each photo starts fitted; carrying a zoom across a photo change disorients.
  useEffect(() => {
    setTransform(FIT_TRANSFORM)
  }, [photo.id])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowLeft') onPrev()
      else if (event.key === 'ArrowRight') onNext()
      else if (event.key === '0') setTransform(FIT_TRANSFORM)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onNext, onPrev])

  /** Apply a transform, clamped so the photo stays reachable. */
  const update = useCallback((next: (previous: Transform) => Transform) => {
    const stage = stageRef.current
    if (!stage) return
    const { width, height } = stage.getBoundingClientRect()
    // `fitScale` is 1 because the untransformed image already fits the stage.
    setTransform((previous) => clampViewerTransform(next(previous), width, height, 1))
  }, [])

  // A non-passive listener is required: React's synthetic wheel handler cannot
  // `preventDefault`, and the wall behind the overlay would scroll instead.
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return

    const handler = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = stage.getBoundingClientRect()
      const cx = event.clientX - rect.left
      const cy = event.clientY - rect.top
      update((previous) =>
        zoomByWheel(previous, event.deltaY, event.deltaMode, cx, cy, {
          speed: 0.0018,
          min: VIEWER_MIN_ZOOM,
          max: maxZoom.current
        })
      )
    }

    stage.addEventListener('wheel', handler, { passive: false })
    return () => stage.removeEventListener('wheel', handler)
  }, [update])

  const onPointerDown = (event: React.PointerEvent): void => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    drag.current = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY, moved: false }
  }

  const onPointerMove = (event: React.PointerEvent): void => {
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

  const onPointerUp = (event: React.PointerEvent): void => {
    const current = drag.current
    drag.current = null
    setDragging(false)
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    // Only a click that did not move closes the viewer.
    if (!current?.moved) onClose()
  }

  const onPointerCancel = (event: React.PointerEvent): void => {
    drag.current = null
    setDragging(false)
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }

  const zoomed = Math.abs(transform.scale - 1) > 0.001
  const imageStyle = zoomed
    ? { transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }
    : undefined

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={photo.name} data-testid="viewer">
      <div
        className={`viewer-stage ${zoomed ? 'zoomed' : ''} ${dragging ? 'dragging' : ''}`}
        ref={stageRef}
        data-testid="viewer-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onDoubleClick={() => setTransform(FIT_TRANSFORM)}
      >
        {previewUrl ? (
          <img
            className={`viewer-image preview ${fullLoaded ? 'hidden' : ''}`}
            src={previewUrl}
            alt=""
            aria-hidden="true"
            style={imageStyle}
            draggable={false}
          />
        ) : null}
        <img
          className={`viewer-image ${fullLoaded ? 'ready' : ''}`}
          src={`pic://photo/${encodeURIComponent(photo.name)}`}
          alt={photo.name}
          style={imageStyle}
          draggable={false}
          onLoad={(event) => {
            recomputeMaxZoom(event.currentTarget)
            setFullLoaded(true)
          }}
        />
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
          </span>
        </div>
        <button
          type="button"
          className="button ghost"
          onClick={() => setTransform(FIT_TRANSFORM)}
          disabled={!zoomed}
          aria-label={t('viewer.fit')}
          title={t('viewer.fit')}
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
