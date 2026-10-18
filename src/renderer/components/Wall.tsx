import type { LayoutResult } from '@shared/layout'
import type { Transform } from '@shared/transform'
import type { Photo } from '@shared/types'
import type { PanZoomHandlers } from '../hooks/usePanZoom'
import { useI18n } from '../i18n/context'
import { Tile } from './Tile'

export interface WallProps {
  layout: LayoutResult
  photos: readonly Photo[]
  thumbUrls: Record<string, string>
  transform: Transform
  square: boolean
  selectedId: string | null
  handlers: PanZoomHandlers
}

/**
 * The wall itself: one transform container plus one tile per photo.
 *
 * Keeping a single container transform (rather than transforming each tile)
 * is what keeps 3000+ tiles at 60 fps: the compositor moves one layer.
 */
export function Wall({ layout, photos, thumbUrls, transform, square, selectedId, handlers }: WallProps): React.JSX.Element {
  const { t } = useI18n()
  const byId = new Map(photos.map((photo) => [photo.id, photo]))

  return (
    <div
      className="stage"
      data-testid="stage"
      role="application"
      aria-label={t('wall.aria')}
      {...handlers}
    >
      <div
        className="world"
        data-testid="world"
        style={{
          width: `${layout.width}px`,
          height: `${layout.height}px`,
          transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`
        }}
      >
        {layout.items.map((item) => {
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
}
