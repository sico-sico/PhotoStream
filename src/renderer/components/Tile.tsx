import { memo } from 'react'
import type { LayoutItem } from '@shared/layout'
import type { Photo } from '@shared/types'
import { useI18n } from '../i18n/context'

export interface TileProps {
  photo: Photo
  item: LayoutItem
  url: string | undefined
  selected: boolean
  square: boolean
}

/**
 * One photo tile.
 *
 * Positioned purely by `transform` so the whole wall can be moved by a single
 * composited transform on the container; changing `left`/`top` instead would
 * force layout on every frame.
 */
export const Tile = memo(function Tile({ photo, item, url, selected, square }: TileProps): React.JSX.Element {
  const { t } = useI18n()
  const takenLabel = photo.takenAt || t('tile.noDate')

  return (
    <div
      className={`tile ${selected ? 'selected' : ''}`}
      data-photo-id={photo.id}
      style={{
        transform: `translate3d(${item.x}px, ${item.y}px, 0)`,
        width: `${item.w}px`,
        height: `${item.h}px`
      }}
    >
      {url ? (
        <img
          src={url}
          alt={photo.name}
          draggable={false}
          decoding="async"
          style={square ? { objectFit: 'cover' } : { objectFit: 'contain' }}
        />
      ) : (
        <div className="tile-placeholder" aria-hidden="true" />
      )}
      <span className="tile-caption" title={`${photo.name}\n${takenLabel}`}>
        {photo.takenAt ? photo.takenAt.slice(0, 10) : t('tile.unknownDate')}
      </span>
    </div>
  )
})
