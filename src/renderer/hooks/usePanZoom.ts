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
 */
export function usePanZoom(
  setTransform: (updater: (previous: Transform) => Transform) => void,
  { wheelTarget, onItemClick, onBackgroundClick }: PanZoomOptions
): PanZoomHandlers {
  const drag = useRef<{
    start: GestureStart
    pointerId: number
    lastX: number
    lastY: number
    source: EventTarget | null
    samples: VelocitySample[]
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
      samples: [{ x: event.clientX, y: event.clientY, time: event.timeStamp }]
    }
  }, [])

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
      setTransform((previous) => panBy(previous, dx, dy))
    },
    [setTransform]
  )

  const endDrag = useCallback(
    (event: React.PointerEvent) => {
      const current = drag.current
      drag.current = null
      if (!current) return
      event.currentTarget.releasePointerCapture?.(event.pointerId)

      const clicked = isClickGesture(current.start, { x: event.clientX, y: event.clientY }, event.timeStamp)
      if (!clicked) return

      const target = current.source as HTMLElement | null
      const tile = target?.closest?.('[data-photo-id]') as HTMLElement | null
      const id = tile?.dataset.photoId
      if (id) onItemClick(id)
      else onBackgroundClick?.()
    },
    [onBackgroundClick, onItemClick]
  )

  const onPointerCancel = useCallback((event: React.PointerEvent) => {
    drag.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }, [])

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
