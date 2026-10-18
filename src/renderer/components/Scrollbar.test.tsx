// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nProvider } from '../i18n/I18nProvider'
import { Scrollbar } from './Scrollbar'

/**
 * The scrollbar is the only way to cross a wall that is tens of thousands of
 * pixels tall, so its interaction is worth exercising beyond the geometry tests
 * in `@shared/scrollbar`.
 */

const viewportHeight = 800

function renderBar(props: Partial<React.ComponentProps<typeof Scrollbar>> = {}): ReturnType<typeof render> {
  return render(
    <I18nProvider preference="en" systemLocales={[]} onLocaleChange={() => {}}>
      <Scrollbar
        transform={{ scale: 1, x: 0, y: 0 }}
        worldHeight={8000}
        viewportHeight={viewportHeight}
        dateAtTop="2020-01-05"
        dateAt={() => '2019-07-14'}
        onScroll={() => {}}
        onPreview={() => {}}
        onScrollTarget={() => {}}
        {...props}
      />
    </I18nProvider>
  )
}

describe('Scrollbar', () => {
  it('hides itself when the whole wall fits', () => {
    // A bar for content that fits implies there is more below, which is false.
    renderBar({ worldHeight: 400 })
    expect(screen.queryByTestId('wall-scrollbar')).toBeNull()
  })

  it('renders when the wall is taller than the window', () => {
    renderBar()
    expect(screen.getByTestId('wall-scrollbar')).toBeInTheDocument()
  })

  it('sizes the thumb from the visible fraction', () => {
    renderBar()
    const thumb = document.querySelector('.scrollbar-thumb') as HTMLElement
    // 800 visible out of 8000: a tenth of the track.
    expect(thumb.style.height).toBe('10%')
  })

  it('moves the thumb with the scroll position', () => {
    renderBar({ transform: { scale: 1, x: 0, y: -3600 } })
    const thumb = document.querySelector('.scrollbar-thumb') as HTMLElement
    // 3600 of 7200 travel is half way, which is 45% of the full track.
    expect(parseFloat(thumb.style.top)).toBeCloseTo(45, 0)
  })

  it('shows the current date, formatted for the active locale', () => {
    // The label goes through the same formatter as the rest of the UI, so it
    // reads 01/05/2020 in English rather than the raw ISO string.
    renderBar()
    expect(document.querySelector('.scrollbar-label')?.textContent).toBe('01/05/2020')
  })

  it('formats the date for the locale', () => {
    render(
      <I18nProvider preference="fr" systemLocales={[]} onLocaleChange={() => {}}>
        <Scrollbar
          transform={{ scale: 1, x: 0, y: 0 }}
          worldHeight={8000}
          viewportHeight={viewportHeight}
          dateAtTop="2020-01-05"
          dateAt={() => ''}
          onScroll={() => {}}
          onPreview={() => {}}
          onScrollTarget={() => {}}
        />
      </I18nProvider>
    )
    expect(document.querySelector('.scrollbar-label')?.textContent).toBe('05/01/2020')
  })

  it('is exposed as a vertical scrollbar', () => {
    renderBar()
    const bar = screen.getByRole('scrollbar')
    expect(bar).toHaveAttribute('aria-orientation', 'vertical')
    expect(bar).toHaveAttribute('aria-valuemin', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '100')
  })

  it('reports the scroll position as a percentage', () => {
    renderBar({ transform: { scale: 1, x: 0, y: -3600 } })
    expect(screen.getByRole('scrollbar')).toHaveAttribute('aria-valuenow', '50')
  })

  it('scrolls to the top on Home', async () => {
    const user = userEvent.setup()
    const onScroll = vi.fn()
    renderBar({ transform: { scale: 1, x: 0, y: -3600 }, onScroll })

    await user.tab()
    await user.keyboard('{Home}')
    expect(onScroll).toHaveBeenCalledWith(expect.objectContaining({ y: expect.closeTo(0, 6) }))
  })

  it('scrolls to the last row on End', async () => {
    const user = userEvent.setup()
    const onScroll = vi.fn()
    renderBar({ onScroll })

    await user.tab()
    await user.keyboard('{End}')
    // 800 viewport out of an 8000 wall: the last row puts y at 800 - 8000.
    expect(onScroll).toHaveBeenCalledWith(expect.objectContaining({ y: -7200 }))
  })

  it('pages down without losing the horizontal position', async () => {
    // Panning sideways is the user's business; the scrollbar only moves y.
    const user = userEvent.setup()
    const onScroll = vi.fn()
    renderBar({ transform: { scale: 1, x: -250, y: 0 }, onScroll })

    await user.tab()
    await user.keyboard('{PageDown}')
    expect(onScroll).toHaveBeenCalledWith(expect.objectContaining({ x: -250 }))
  })

  it('keeps the zoom unchanged', async () => {
    const user = userEvent.setup()
    const onScroll = vi.fn()
    renderBar({ transform: { scale: 2, x: 0, y: 0 }, onScroll })

    await user.tab()
    await user.keyboard('{PageDown}')
    expect(onScroll).toHaveBeenCalledWith(expect.objectContaining({ scale: 2 }))
  })

  it('localises the accessible label', () => {
    render(
      <I18nProvider preference="zh-CN" systemLocales={[]} onLocaleChange={() => {}}>
        <Scrollbar
          transform={{ scale: 1, x: 0, y: 0 }}
          worldHeight={8000}
          viewportHeight={viewportHeight}
          dateAtTop="2020-01-05"
          dateAt={() => ''}
          onScroll={() => {}}
          onPreview={() => {}}
          onScrollTarget={() => {}}
        />
      </I18nProvider>
    )
    expect(screen.getByRole('scrollbar', { name: '滚动照片墙' })).toBeInTheDocument()
  })
})
