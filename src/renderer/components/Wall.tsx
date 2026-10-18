import { forwardRef, memo, useImperativeHandle, useMemo, useRef } from 'react'
import type { LayoutResult } from '@shared/layout'
import type { Transform } from '@shared/transform'
import type { Photo } from '@shared/types'
import type { CullResult } from '@shared/cull'
import type { PanZoomHandlers } from '../hooks/usePanZoom'
import { useI18n } from '../i18n/context'
import { Tile } from './Tile'

export interface WallProps {
  layout: LayoutResult
  /** Every photo in the library, keyed by id below. */
  photos: readonly Photo[]
  /**
   * The tiles to mount.
   *
   * Passed in rather than computed here: the same set decides which thumbnails
   * are requested, and two independent computations drifted apart — one used a
   * different margin and a different truncation rule, which left mounted tiles
   * with no image at all when zoomed out.
   */
  mounted: CullResult
  thumbUrls: Record<string, string>
  transform: Transform
  square: boolean
  selectedId: string | null
  handlers: PanZoomHandlers
  /**
   * Animate the next transform change.
   *
   * Keyboard steps and auto-scroll jump by a whole tile, which reads as a teleport
   * without a transition. Dragging must never animate — it would lag the cursor —
   * so this is passed in per move rather than baked into the CSS.
   */
  animate?: boolean
  /**
   * Ease wheel-driven moves.
   *
   * Separate from `animate` because a wheel notch needs a much shorter, linear
   * glide: one notch is ~120 px, and the 220 ms decelerating curve used for a
   * whole-tile keyboard step would make a continuous scroll trail the wheel.
   * The transform itself is still committed immediately; only the painting eases.
   */
  wheeling?: boolean
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

/** Shared by the style attribute and the imperative path, so they cannot drift. */
function worldTransform(t: Transform): string {
  return `translate3d(${t.x}px, ${t.y}px, 0) scale(${t.scale})`
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
    { layout, photos, mounted, thumbUrls, transform, square, selectedId, handlers, animate = false, wheeling = false },
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
          world.style.transform = worldTransform(next)
        }
      }),
      []
    )

    const byId = useMemo(() => new Map(photos.map((photo) => [photo.id, photo])), [photos])

    // Only tiles near the viewport are mounted; the set comes from `useWall` so
    // the thumbnail requests use exactly the same one.
    const visible = mounted

    return (
      <div className="stage" data-testid="stage" role="application" aria-label={t('wall.aria')} {...handlers}>
        <div
          className={`world ${wheeling ? 'wheeling' : ''} ${animate ? 'settling' : ''}`}
          data-testid="world"
          ref={worldRef}
          style={{
            width: `${layout.width}px`,
            height: `${layout.height}px`,
            transform: worldTransform(transform)
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
