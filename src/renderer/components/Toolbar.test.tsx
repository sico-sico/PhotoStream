// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nProvider } from '../i18n/I18nProvider'
import { Toolbar } from './Toolbar'

/**
 * The rendered stylesheet, read from disk with comments removed.
 *
 * jsdom evaluates no CSS, so `getComputedStyle` reports nothing for the drag
 * region. Reading the source file makes the assertion about the CSS that ships,
 * which is exactly what a missing `-webkit-app-region` would break.
 */
const stylesheet = readFileSync(join(__dirname, '..', 'styles.css'), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '')

/** Extract the body of the rule whose selector list contains `selector` exactly. */
function cssRule(selector: string): string {
  // All declarations blocks in the file, with their selector lists.
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g
  for (const match of stylesheet.matchAll(rulePattern)) {
    const selectors = match[1]
      .split(',')
      .map((part) => part.replace(/\s+/g, ' ').trim())
      .filter((part) => part.length > 0)
    if (selectors.includes(selector)) return match[2]
  }
  throw new Error(`no rule for ${selector}`)
}

function renderToolbar(props: Partial<React.ComponentProps<typeof Toolbar>> = {}, locale = 'en'): ReturnType<typeof render> {
  return render(
    <I18nProvider preference={locale} systemLocales={[]} onLocaleChange={() => {}}>
      <Toolbar
        dir="/photos"
        layout="grid"
        sort="taken-desc"
        filtersOpen={false}
        busy={false}
        visibleCount={10}
        totalCount={20}
        onChooseFolder={() => {}}
        onLayoutChange={() => {}}
        onSortChange={() => {}}
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

  it('keeps the folder name as a plain text block so it stays at the left edge', () => {
    // It carries `direction: rtl` so a long path truncates from the start. That
    // only reads correctly while the element is a normal block: as a flex
    // container the inline start flips to the right and the text jumps across
    // the bar.
    //
    // jsdom loads no stylesheets, so the rule is asserted from the source file.
    const rule = cssRule('.dir-label')
    expect(rule).not.toMatch(/display:\s*flex/)
    expect(rule).toMatch(/direction:\s*rtl/)
    expect(rule).toMatch(/text-align:\s*left/)
  })

  it('makes the folder name the window drag handle', () => {
    // The toolbar's buttons are all `no-drag`, and the path readout is the only
    // wide non-interactive area left, so without this the frameless window
    // could not be moved at all.
    expect(cssRule('.dir-label')).toMatch(/-webkit-app-region:\s*drag/)
  })

  it('does not exclude the localisation-safe label from dragging', () => {
    // `.dir-label` used to sit in the toolbar's blanket `no-drag` list, which
    // silently undid the rule above and left the window unmovable.
    const shared = cssRule('.toolbar button')
    expect(shared).not.toContain('.dir-label')
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
    // The number itself is compact; the surrounding counters are labelled so
    // two `x/y` values can never look like a duplicated indicator.
    expect(screen.getByText('10/20')).toBeInTheDocument()
  })

  it('labels the thumbnail counter so it is not confused with the photo count', () => {
    // The thumbnail counter was removed entirely: generation is demand-driven
    // now, so its total was meaningless and it read as a duplicate.
    renderToolbar()
    const counters = document.querySelectorAll('.toolbar-stats > *')
    expect(counters).toHaveLength(1)
    expect(counters[0].textContent).toBe('10/20')
  })

  it('renders the window controls', () => {
    renderToolbar()
    expect(screen.getByRole('button', { name: 'Minimize' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Maximize' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })

  it('shows no progress counter', () => {
    renderToolbar()
    expect(screen.queryByTitle('Thumbnails')).toBeNull()
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
