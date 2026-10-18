import { useCallback, useEffect, useRef } from 'react'
import { isClickGesture, pushSample, type GestureStart, type VelocitySample } from '@shared/gesture'
import { panBy, zoomByWheel, type Transform } from '@shared/transform'

export interface PanZoomHandlers {
  onPointerDown: (event: React.PointerEvent) => void
  onPointerMove: (event: React.PointerEvent) => void
  onPointerUp: (event: React.PointerEvent) => void
  onPointerCancel: (event: React.PointerEvent) => void
}

export interface PanZoomOptions {
  /** Element that receives the wheel listener; defaults to `window`. */
  wheelTarget?: HTMLElement | Window | null
  /** Called with the photo id when a click lands on a tile. */
  onItemClick: (id: string) => void
  /** Called when a click lands on empty wall. */
  onBackgroundClick?: () => void
  /**
   * Called on every pointer move with the transform to display.
   *
   * Panning uses this to write the transform straight to the DOM: with one node
   * per photo, routing a 60 Hz drag through React state re-rendered the whole
   * tile list every frame (measured at 27 ms/frame for 3226 photos).
   */
  onLiveTransform?: (transform: Transform) => void
  /** Latest committed transform, so a drag starts from the right place. */
  getTransform?: () => Transform
}

/**
 * Drag-to-pan and wheel-to-zoom for the wall.
 *
 * Pointer events (not mouse events) so touch and pen work for free. Whether a
 * gesture counts as a click is decided by `@shared/gesture`, which is unit
 * tested; this hook only routes the result.
 *
 * `setTransform` takes an updater so pointer moves compose against the latest
 * transform even when several events land inside one frame.
 *
 * During a drag the transform is pushed to `onLiveTransform` per frame and only
 * committed to `setTransform` once, on release. Writing it to the DOM directly
 * keeps a 3000-photo wall inside the 16.7 ms frame budget; React then does a
 * single re-render with the final position, which also refreshes the culled tile
 * set.
 */
export function usePanZoom(
  setTransform: (updater: (previous: Transform) => Transform) => void,
  { wheelTarget, onItemClick, onBackgroundClick, onLiveTransform, getTransform }: PanZoomOptions
): PanZoomHandlers {
  const drag = useRef<{
    start: GestureStart
    pointerId: number
    lastX: number
    lastY: number
    source: EventTarget | null
    samples: VelocitySample[]
    /** Transform with the drag applied, replayed into state on release. */
    live: Transform
  } | null>(null)

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    drag.current = {
      start: { x: event.clientX, y: event.clientY, time: event.timeStamp },
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
      source: event.target,
      samples: [{ x: event.clientX, y: event.clientY, time: event.timeStamp }],
      live: getTransform?.() ?? { scale: 1, x: 0, y: 0 }
    }
  }, [getTransform])

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const current = drag.current
      if (!current || current.pointerId !== event.pointerId) return
      const dx = event.clientX - current.lastX
      const dy = event.clientY - current.lastY
      if (dx === 0 && dy === 0) return

      current.lastX = event.clientX
      current.lastY = event.clientY
      current.samples = pushSample(current.samples, { x: event.clientX, y: event.clientY, time: event.timeStamp })
      // Direct manipulation: one screen pixel of drag moves one screen pixel.
      current.live = panBy(current.live, dx, dy)
      // Per-frame: straight to the DOM, no React render.
      onLiveTransform?.(current.live)
    },
    [onLiveTransform]
  )

  const endDrag = useCallback(
    (event: React.PointerEvent) => {
      const current = drag.current
      drag.current = null
      if (!current) return
      event.currentTarget.releasePointerCapture?.(event.pointerId)

      // Commit the position once, so React state (and the culled tile set) catch
      // up with what the DOM already shows. Without this the next render would
      // snap the wall back to the pre-drag transform.
      setTransform(() => current.live)

      const clicked = isClickGesture(current.start, { x: event.clientX, y: event.clientY }, event.timeStamp)
      if (!clicked) return

      const target = current.source as HTMLElement | null
      const tile = target?.closest?.('[data-photo-id]') as HTMLElement | null
      const id = tile?.dataset.photoId
      if (id) onItemClick(id)
      else onBackgroundClick?.()
    },
    [onBackgroundClick, onItemClick, setTransform]
  )

  const onPointerCancel = useCallback(
    (event: React.PointerEvent) => {
      const current = drag.current
      drag.current = null
      event.currentTarget.releasePointerCapture?.(event.pointerId)
      // A cancelled gesture still keeps the pixels the user already dragged to.
      if (current) setTransform(() => current.live)
    },
    [setTransform]
  )

  // A non-passive listener is required: React's synthetic wheel handler is
  // passive, so `preventDefault` there would be ignored and the page would
  // scroll behind the wall.
  useEffect(() => {
    const target = wheelTarget ?? window
    const handler = (event: Event): void => {
      const wheel = event as WheelEvent
      wheel.preventDefault()
      setTransform((previous) => zoomByWheel(previous, wheel.deltaY, wheel.deltaMode, wheel.clientX, wheel.clientY))
    }
    target.addEventListener('wheel', handler, { passive: false })
    return () => target.removeEventListener('wheel', handler)
  }, [setTransform, wheelTarget])

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel
  }
}
