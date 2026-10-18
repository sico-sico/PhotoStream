import { useCallback, useRef, useState } from 'react'
import type { Transform } from '@shared/transform'
import { scrollMetrics, scrollOffsetToY, scrollToWorldY } from '@shared/scrollbar'
import { formatIsoDate } from '@shared/i18n'
import { useI18n } from '../i18n/context'

export interface ScrollbarProps {
  transform: Transform
  /** Wall height in world units. */
  worldHeight: number
  viewportHeight: number
  /** World row at the top of the window, used to label the thumb. */
  dateAtTop: string
  /** Resolves the date for a world row, used while dragging. */
  dateAt: (worldY: number) => string
  /** Called with the transform a drag implies. */
  onScroll: (next: Transform) => void
  /** Called while dragging so the label can preview the destination date. */
  onPreview: (date: string) => void
  /**
   * Called with the world row a scroll is heading for, before it happens.
   *
   * Lets the wall start loading destination thumbnails while the jump is still
   * animating; without it a scrollbar jump lands on empty placeholders.
   */
  onScrollTarget: (worldY: number) => void
}

/**
 * Vertical scrollbar for the wall.
 *
 * A wall of thousands of photos is tens of thousands of pixels tall; dragging is
 * fine for small movements but useless for crossing a year, so a proportional
 * control is what makes the library navigable.
 *
 * The thumb is sized from the visible fraction and dragged as a fraction of the
 * track, so it behaves the same at any zoom. While dragging, the date under
 * the thumb is shown — the layout already knows where the photos are, so no
 * tiles have to be mounted to answer that.
 */
export function Scrollbar({
  transform,
  worldHeight,
  viewportHeight,
  dateAtTop,
  dateAt,
  onScroll,
  onPreview,
  onScrollTarget
}: ScrollbarProps): React.JSX.Element | null {
  const { t, locale } = useI18n()
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState(false)
  /** Date under the thumb while dragging; `null` when idle. */
  const [preview, setPreview] = useState<string | null>(null)

  const metrics = scrollMetrics(transform, worldHeight, viewportHeight)

  /**
   * Distance from the pointer to the thumb's top edge, held for the whole drag.
   *
   * Keeping it constant is what makes the thumb stay put under the cursor: the
   * pointer moves by `d`, the thumb moves by `d`, and the relationship between
   * them never changes. Two bugs came from getting this wrong:
   *
   * - clicking the track used half the *thumb height* as the offset, which is a
   *   different quantity entirely, so the wall jumped down (or up) on click;
   * - dragging passed `0`, i.e. assumed the pointer was always on the thumb's top
   *   edge, so grabbing anywhere else snapped the thumb to the cursor first and
   *   the wall appeared frozen until the pointer had travelled back that far.
   */
  const grabOffsetRef = useRef(0)

  /**
   * Translate a pointer position on the track into a scroll.
   *
   * @param clientY pointer position, in viewport coordinates
   */
  const scrollToPointer = useCallback(
    (clientY: number) => {
      const track = trackRef.current
      if (!track) return
      const rect = track.getBoundingClientRect()
      if (!(rect.height > 0)) return

      const top = clientY - rect.top - grabOffsetRef.current
      // Position of the thumb's top as a fraction of the whole track. The top
      // edge ranges over 0 .. (1 - size), so clamping to that range is what stops
      // a drag past either end. `scrollOffsetToY` takes this fraction and divides
      // by `1 - size` itself; passing progress along the travel instead divided
      // twice and overshot by `1 / (1 - size)`.
      const maxTopFraction = 1 - metrics.size
      const trackFraction = Math.min(Math.max(top / rect.height, 0), maxTopFraction)
      const y = scrollOffsetToY(trackFraction, worldHeight, viewportHeight, transform.scale)
      // Announce the destination *before* scrolling, so the wall can start
      // fetching those tiles while the transition is still running.
      onScrollTarget(-y / (transform.scale > 0 ? transform.scale : 1))
      onScroll({ scale: transform.scale, x: transform.x, y })
      // Report the date at the destination row so the label can name it.
      onPreview(dateAt(-y / (transform.scale > 0 ? transform.scale : 1)))
    },
    [dateAt, metrics.size, onPreview, onScroll, onScrollTarget, transform.scale, transform.x, viewportHeight, worldHeight]
  )

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const track = trackRef.current
    if (!track) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setDragging(true)

    const rect = track.getBoundingClientRect()
    const thumbTop = rect.top + rect.height * metrics.offset
    const thumbBottom = thumbTop + rect.height * metrics.size
    const insideThumb = event.clientY >= thumbTop && event.clientY <= thumbBottom

    if (insideThumb) {
      // Grabbing the thumb: keep the exact point the user took hold of.
      grabOffsetRef.current = event.clientY - thumbTop
    } else {
      // Clicking the track: centre the thumb on the pointer, so the click
      // lands where the user aimed instead of offsetting by a fraction of it.
      grabOffsetRef.current = (rect.height * metrics.size) / 2
    }

    scrollToPointer(event.clientY)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    // Same offset as on pointerdown: the thumb travels with the pointer rather
    // than snapping to it.
    scrollToPointer(event.clientY)
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    setDragging(false)
    setPreview(null)
  }

  // Keyboard access: Page Up/Down and Home/End are what a scrollbar offers.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const scale = transform.scale > 0 ? transform.scale : 1
    // Everything below is in world units, which is what `scrollToWorldY` wants.
    const visibleWorld = viewportHeight / scale
    const currentTop = -transform.y / scale
    const step = worldHeight * 0.1

    let nextWorldY: number
    switch (event.key) {
      case 'PageDown':
        nextWorldY = currentTop + visibleWorld * 0.9
        break
      case 'PageUp':
        nextWorldY = currentTop - visibleWorld * 0.9
        break
      case 'Home':
        nextWorldY = 0
        break
      case 'End':
        nextWorldY = worldHeight - visibleWorld
        break
      case 'ArrowDown':
        nextWorldY = currentTop + step
        break
      case 'ArrowUp':
        nextWorldY = currentTop - step
        break
      default:
        return
    }

    event.preventDefault()
    const target = Math.max(0, nextWorldY)
    // Same reason as on drag: announce the destination so the tiles can load
    // while the wall animates there. `End` on a large library jumps tens of
    // thousands of pixels at once.
    onScrollTarget(target)
    onScroll({ scale: transform.scale, x: transform.x, y: scrollToWorldY(target, transform.scale) })
  }

  // The scrollbar is only meaningful when there is something below the fold.
  if (!metrics.scrollable) return null

  const label = dragging && preview ? preview : dateAtTop

  return (
    <div
      className={`scrollbar ${dragging ? 'dragging' : ''}`}
      ref={trackRef}
      data-testid="wall-scrollbar"
      role="scrollbar"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t('wall.scrollbar')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round((metrics.offset / Math.max(1e-6, 1 - metrics.size)) * 100)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    >
      <div
        className="scrollbar-thumb"
        style={{ top: `${metrics.offset * 100}%`, height: `${metrics.size * 100}%` }}
      />

      {label ? (
        <div
          className="scrollbar-label"
          aria-hidden="true"
          // Anchored to the thumb's mid-point, not the pointer, so it does not
          // jitter while dragging.
          style={{ top: `${(metrics.offset + metrics.size / 2) * 100}%` }}
        >
          {formatIsoDate(locale, label) || label}
        </div>
      ) : null}
    </div>
  )
}
