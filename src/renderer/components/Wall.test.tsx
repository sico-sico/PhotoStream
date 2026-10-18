// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Photo } from '@shared/types'
import { I18nProvider } from '../i18n/I18nProvider'
import { Wall } from './Wall'
import type { PanZoomHandlers } from '../hooks/usePanZoom'

const photos: Photo[] = [
  { id: 'a', path: '/a.jpg', name: 'alpha.jpg', width: 1, height: 1, takenAt: '2019-07-14', dateSource: 'exif', mtimeMs: 0, sizeBytes: 0 },
  { id: 'b', path: '/b.jpg', name: 'bravo.jpg', width: 2, height: 1, takenAt: '', dateSource: 'none', mtimeMs: 0, sizeBytes: 0 }
]

const layout = {
  width: 500,
  height: 200,
  items: [
    { id: 'a', x: 0, y: 0, w: 100, h: 100 },
    { id: 'b', x: 110, y: 0, w: 100, h: 100 }
  ]
}

const handlers: PanZoomHandlers = {
  onPointerDown: () => {},
  onPointerMove: () => {},
  onPointerUp: () => {},
  onPointerCancel: () => {}
}

function renderWall(props: Partial<React.ComponentProps<typeof Wall>> = {}): ReturnType<typeof render> {
  return render(
    <I18nProvider preference="en" systemLocales={[]} onLocaleChange={() => {}}>
      <Wall
        layout={layout}
        photos={photos}
        thumbUrls={{ a: 'pic://thumb/a-wall.webp' }}
        transform={{ scale: 2, x: 10, y: 20 }}
        square={false}
        selectedId={null}
        handlers={handlers}
        {...props}
      />
    </I18nProvider>
  )
}

describe('Wall', () => {
  it('renders one tile per positioned item', () => {
    renderWall()
    expect(document.querySelectorAll('[data-photo-id]')).toHaveLength(2)
  })

  it('sizes the world to the layout bounds', () => {
    renderWall()
    const world = screen.getByTestId('world')
    expect(world).toHaveStyle({ width: '500px', height: '200px' })
  })

  it('applies the transform to the single container', () => {
    // One composited transform on the container is what keeps 3000+ tiles at
    // 60 fps; per-tile transforms would force a layer per tile.
    renderWall()
    expect(screen.getByTestId('world')).toHaveStyle({
      transform: 'translate3d(10px, 20px, 0) scale(2)'
    })
  })

  it('positions each tile with its own translate, never left/top', () => {
    renderWall()
    const tiles = document.querySelectorAll<HTMLElement>('[data-photo-id]')
    expect(tiles[0].style.transform).toBe('translate3d(0px, 0px, 0)')
    expect(tiles[1].style.transform).toBe('translate3d(110px, 0px, 0)')
    expect(tiles[0].style.left).toBe('')
  })

  it('skips items with no matching photo', () => {
    renderWall({ layout: { ...layout, items: [...layout.items, { id: 'ghost', x: 0, y: 0, w: 10, h: 10 }] } })
    expect(document.querySelectorAll('[data-photo-id]')).toHaveLength(2)
  })

  it('marks the selected tile', () => {
    renderWall({ selectedId: 'b' })
    const selected = document.querySelector('.tile.selected')
    expect(selected).toHaveAttribute('data-photo-id', 'b')
  })

  it('shows a placeholder until the thumbnail URL arrives', () => {
    renderWall()
    const tiles = document.querySelectorAll<HTMLElement>('[data-photo-id]')
    expect(tiles[0].querySelector('img')).toHaveAttribute('src', 'pic://thumb/a-wall.webp')
    expect(tiles[1].querySelector('.tile-placeholder')).not.toBeNull()
  })

  it('uses cover for square mode and contain otherwise', () => {
    const { rerender } = renderWall()
    expect(document.querySelector<HTMLImageElement>('img')?.style.objectFit).toBe('contain')

    rerender(
      <I18nProvider preference="en" systemLocales={[]} onLocaleChange={() => {}}>
        <Wall
          layout={layout}
          photos={photos}
          thumbUrls={{ a: 'pic://thumb/a-wall.webp' }}
          transform={{ scale: 2, x: 10, y: 20 }}
          square
          selectedId={null}
          handlers={handlers}
        />
      </I18nProvider>
    )
    expect(document.querySelector<HTMLImageElement>('img')?.style.objectFit).toBe('cover')
  })

  it('is exposed as an application region with a localised label', () => {
    renderWall()
    expect(screen.getByRole('application')).toBeInTheDocument()
  })

  it('labels the region in the active language', () => {
    render(
      <I18nProvider preference="zh-CN" systemLocales={[]} onLocaleChange={() => {}}>
        <Wall
          layout={layout}
          photos={photos}
          thumbUrls={{}}
          transform={{ scale: 1, x: 0, y: 0 }}
          square={false}
          selectedId={null}
          handlers={handlers}
        />
      </I18nProvider>
    )
    expect(screen.getByRole('application', { name: '照片墙' })).toBeInTheDocument()
  })

  it('shows a dash for photos with no capture date', () => {
    renderWall()
    const caption = document.querySelectorAll('.tile-caption')[1]
    expect(caption).toHaveTextContent('—')
  })

  it('shows the capture date on the caption', () => {
    renderWall()
    expect(document.querySelectorAll('.tile-caption')[0]).toHaveTextContent('2019-07-14')
  })
})
