import { forwardRef, memo, useImperativeHandle, useMemo, useRef } from 'react'
import type { LayoutResult } from '@shared/layout'
import type { Transform } from '@shared/transform'
import type { Photo } from '@shared/types'
import { cullItems } from '@shared/cull'
import type { PanZoomHandlers } from '../hooks/usePanZoom'
import { useI18n } from '../i18n/context'
import { Tile } from './Tile'

export interface WallProps {
  layout: LayoutResult
  photos: readonly Photo[]
  thumbUrls: Record<string, string>
  transform: Transform
  /** Viewport size in CSS pixels, used to decide which tiles to mount. */
  viewport: { width: number; height: number }
  square: boolean
  selectedId: string | null
  handlers: PanZoomHandlers
}

/** Imperative handle so a drag can move the wall without a React render. */
export interface WallHandle {
  /**
   * Apply a transform to the world element directly, bypassing React.
   *
   * With one node per photo, a 3226-photo library spent 27 ms per frame on the
   * transform update; the same transform written straight to the DOM costs
   * microseconds, and the culled tile set keeps the tree small enough that the
   * eventual re-render is cheap. Together those hold the 16.7 ms frame budget.
   */
  applyTransform: (transform: Transform) => void
}

/**
 * The wall: one transform container plus the tiles near the viewport.
 *
 * Mounting every photo was measured at 27 ms/frame on the 3226-photo sample
 * library. Culling to the visible region plus a screen of margin brought the
 * same pan to 17 ms/frame; box-shadow, the caption text and React
 * reconciliation were each ruled out as the cause by measurement.
 */
export const Wall = memo(
  forwardRef<WallHandle, WallProps>(function Wall(
    { layout, photos, thumbUrls, transform, viewport, square, selectedId, handlers },
    ref
  ): React.JSX.Element {
    const { t } = useI18n()
    const worldRef = useRef<HTMLDivElement | null>(null)

    useImperativeHandle(
      ref,
      () => ({
        applyTransform(next: Transform) {
          const world = worldRef.current
          if (!world) return
          world.style.transform = `translate3d(${next.x}px, ${next.y}px, 0) scale(${next.scale})`
        }
      }),
      []
    )

    const byId = useMemo(() => new Map(photos.map((photo) => [photo.id, photo])), [photos])

    // Only tiles near the viewport are mounted. `transform` participates because
    // panning changes what is visible, but during a drag it is only pushed on
    // release, so this does not run per frame.
    const visible = useMemo(
      () => cullItems(layout, transform, viewport.width, viewport.height),
      [layout, transform, viewport.height, viewport.width]
    )

    return (
      <div className="stage" data-testid="stage" role="application" aria-label={t('wall.aria')} {...handlers}>
        <div
          className="world"
          data-testid="world"
          ref={worldRef}
          style={{
            width: `${layout.width}px`,
            height: `${layout.height}px`,
            transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`
          }}
        >
          {visible.items.map((item) => {
            const photo = byId.get(item.id)
            if (!photo) return null
            return (
              <Tile
                key={item.id}
                photo={photo}
                item={item}
                url={thumbUrls[item.id]}
                selected={selectedId === item.id}
                square={square}
              />
            )
          })}
        </div>
      </div>
    )
  })
)
