// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nProvider } from '../i18n/I18nProvider'
import { Toolbar } from './Toolbar'

function renderToolbar(props: Partial<React.ComponentProps<typeof Toolbar>> = {}, locale = 'en'): ReturnType<typeof render> {
  return render(
    <I18nProvider preference={locale} systemLocales={[]} onLocaleChange={() => {}}>
      <Toolbar
        dir="/photos"
        layout="grid"
        filtersOpen={false}
        progress={null}
        busy={false}
        visibleCount={10}
        totalCount={20}
        onChooseFolder={() => {}}
        onLayoutChange={() => {}}
        onToggleFilters={() => {}}
        {...props}
      />
    </I18nProvider>
  )
}

describe('Toolbar', () => {
  it('shows the current directory', () => {
    renderToolbar()
    expect(screen.getByText('/photos')).toBeInTheDocument()
  })

  it('shows a scanning indicator while busy', () => {
    renderToolbar({ busy: true })
    expect(screen.getByText('Scanning…')).toBeInTheDocument()
  })

  it('shows a placeholder when no folder is open', () => {
    renderToolbar({ dir: '' })
    expect(screen.getByText('No folder selected')).toBeInTheDocument()
  })

  it('reports the visible and total counts', () => {
    renderToolbar()
    expect(screen.getByText('10/20')).toBeInTheDocument()
  })

  it('shows progress only when there is work', () => {
    const { rerender } = renderToolbar({ progress: null })
    expect(screen.queryByTitle('Thumbnails')).toBeNull()

    rerender(
      <I18nProvider preference="en" systemLocales={[]} onLocaleChange={() => {}}>
        <Toolbar
          dir="/photos"
          layout="grid"
          filtersOpen={false}
          progress={{ done: 3, total: 9 }}
          busy={false}
          visibleCount={9}
          totalCount={9}
          onChooseFolder={() => {}}
          onLayoutChange={() => {}}
          onToggleFilters={() => {}}
        />
      </I18nProvider>
    )
    expect(screen.getByTitle('Thumbnails')).toHaveTextContent('3/9')
  })

  it('marks the active layout', () => {
    renderToolbar({ layout: 'masonry' })
    expect(screen.getByRole('button', { name: 'Masonry' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Rows' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('emits the chosen layout', async () => {
    const user = userEvent.setup()
    const onLayoutChange = vi.fn()
    renderToolbar({ onLayoutChange })

    await user.click(screen.getByRole('button', { name: 'Square' }))
    expect(onLayoutChange).toHaveBeenCalledWith('square')
  })

  it('toggles the filter panel and exposes its state', async () => {
    const user = userEvent.setup()
    const onToggleFilters = vi.fn()
    renderToolbar({ filtersOpen: true, onToggleFilters })

    const button = screen.getByRole('button', { name: 'Filters' })
    expect(button).toHaveAttribute('aria-expanded', 'true')

    await user.click(button)
    expect(onToggleFilters).toHaveBeenCalledTimes(1)
  })

  it('opens the folder picker', async () => {
    const user = userEvent.setup()
    const onChooseFolder = vi.fn()
    renderToolbar({ onChooseFolder })

    await user.click(screen.getByRole('button', { name: /open folder/i }))
    expect(onChooseFolder).toHaveBeenCalledTimes(1)
  })

  it('localises every label', () => {
    renderToolbar({}, 'zh-CN')
    expect(screen.getByRole('button', { name: '等高行' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '瀑布流' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '正方形' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '筛选' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /打开文件夹/ })).toBeInTheDocument()
  })

  it('localises the layout group label for screen readers', () => {
    renderToolbar({}, 'fr')
    expect(screen.getByRole('group', { name: 'Disposition' })).toBeInTheDocument()
  })
})
