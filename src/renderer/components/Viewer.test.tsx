// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Photo } from '@shared/types'
import { I18nProvider } from '../i18n/I18nProvider'
import { Viewer } from './Viewer'

const photo: Photo = {
  id: 'p1',
  path: '/photos/kyoto.jpg',
  name: 'kyoto.jpg',
  width: 6000,
  height: 4000,
  takenAt: '2019-07-14',
  dateSource: 'exif',
  mtimeMs: 0,
  sizeBytes: 0
}

function renderViewer(props: Partial<React.ComponentProps<typeof Viewer>> = {}, locale = 'en'): ReturnType<typeof render> {
  return render(
    <I18nProvider preference={locale} systemLocales={[]} onLocaleChange={() => {}}>
      <Viewer
        photo={photo}
        previewUrl="pic://thumb/hash-wall.webp"
        onClose={() => {}}
        onPrev={() => {}}
        onNext={() => {}}
        onReveal={() => {}}
        {...props}
      />
    </I18nProvider>
  )
}

describe('Viewer', () => {
  it('shows the file name and dimensions', () => {
    renderViewer()
    expect(screen.getByText('kyoto.jpg')).toBeInTheDocument()
    expect(screen.getByText(/6000×4000/)).toBeInTheDocument()
  })

  it('renders the cached preview immediately and the original alongside it', () => {
    renderViewer()
    const preview = document.querySelector('img.preview')
    const full = document.querySelector('img:not(.preview)')

    expect(preview).toHaveAttribute('src', 'pic://thumb/hash-wall.webp')
    // The full-resolution image streams through the custom protocol.
    expect(full?.getAttribute('src')).toContain('pic://photo/')
    expect(full?.getAttribute('src')).toContain('kyoto.jpg')
  })

  it('hides the preview once the original has loaded', async () => {
    renderViewer()
    const full = document.querySelector('img:not(.preview)') as HTMLImageElement

    expect(full.className).not.toContain('ready')
    full.dispatchEvent(new Event('load'))
    await screen.findByText('kyoto.jpg')

    expect(document.querySelector('img.preview')?.className).toContain('hidden')
    expect(full.className).toContain('ready')
  })

  it('closes on Escape, steps on arrow keys', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onPrev = vi.fn()
    const onNext = vi.fn()
    renderViewer({ onClose, onPrev, onNext })

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)

    await user.keyboard('{ArrowLeft}')
    expect(onPrev).toHaveBeenCalledTimes(1)

    await user.keyboard('{ArrowRight}')
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('stops listening after unmount', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const { unmount } = renderViewer({ onClose })

    unmount()
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on a click anywhere in the stage', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderViewer({ onClose })

    await user.click(screen.getByTestId('viewer-stage'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close when the gesture was a drag', async () => {
    // Panning a zoomed photo must never be mistaken for "click to dismiss".
    const onClose = vi.fn()
    renderViewer({ onClose })

    const stage = screen.getByTestId('viewer-stage')
    stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0, clientX: 100, clientY: 100 }))
    stage.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 240, clientY: 220 }))
    stage.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: 240, clientY: 220 }))

    expect(onClose).not.toHaveBeenCalled()
  })

  it('wires the toolbar buttons', async () => {
    const user = userEvent.setup()
    const onPrev = vi.fn()
    const onNext = vi.fn()
    const onClose = vi.fn()
    const onReveal = vi.fn()
    renderViewer({ onPrev, onNext, onClose, onReveal })

    await user.click(screen.getByRole('button', { name: /previous photo/i }))
    await user.click(screen.getByRole('button', { name: /next photo/i }))
    await user.click(screen.getByRole('button', { name: /close viewer/i }))
    await user.click(screen.getByRole('button', { name: /show in folder/i }))

    expect(onPrev).toHaveBeenCalledTimes(1)
    expect(onNext).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onReveal).toHaveBeenCalledTimes(1)
  })

  it('is announced as a modal dialog named after the photo', () => {
    renderViewer()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleName('kyoto.jpg')
  })

  it('localises the interface', () => {
    renderViewer({}, 'zh-CN')
    expect(screen.getByRole('button', { name: '上一张' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '关闭查看' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '在文件夹中显示' })).toBeInTheDocument()
  })

  it('reports a missing capture date instead of showing a blank', () => {
    renderViewer({ photo: { ...photo, takenAt: '', dateSource: 'none' } }, 'fr')
    expect(screen.getByText(/aucune date de prise de vue/)).toBeInTheDocument()
  })

  it('omits the dimensions when they are unknown', () => {
    renderViewer({ photo: { ...photo, width: 0, height: 0 } })
    expect(screen.queryByText(/×/)).toBeNull()
  })

  it('resets the preview when switching photos', async () => {
    const { rerender } = renderViewer()
    const full = document.querySelector('img:not(.preview)') as HTMLImageElement
    full.dispatchEvent(new Event('load'))
    await screen.findByText('kyoto.jpg')
    expect(full.className).toContain('ready')

    rerender(
      <I18nProvider preference="en" systemLocales={[]} onLocaleChange={() => {}}>
        <Viewer
          photo={{ ...photo, id: 'p2', name: 'paris.jpg' }}
          previewUrl="pic://thumb/other-wall.webp"
          onClose={() => {}}
          onPrev={() => {}}
          onNext={() => {}}
          onReveal={() => {}}
        />
      </I18nProvider>
    )

    const next = document.querySelector('img:not(.preview)') as HTMLImageElement
    // The new photo must not inherit the previous photo's "loaded" state, or the
    // thumbnail would be hidden before the original arrives.
    expect(next.className).not.toContain('ready')
  })
})
