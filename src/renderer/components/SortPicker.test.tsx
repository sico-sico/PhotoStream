// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nProvider } from '../i18n/I18nProvider'
import { SortPicker } from './SortPicker'

function renderPicker(props: Partial<React.ComponentProps<typeof SortPicker>> = {}, locale = 'en'): ReturnType<typeof render> {
  return render(
    <I18nProvider preference={locale} systemLocales={[]} onLocaleChange={() => {}}>
      <SortPicker sort="taken-desc" onChange={() => {}} {...props} />
    </I18nProvider>
  )
}

describe('SortPicker', () => {
  it('shows the active ordering on the trigger', () => {
    renderPicker()
    // The label has to be visible: an icon alone cannot say whether "newest"
    // means by date or by name.
    expect(screen.getByRole('button', { name: 'Sort order' })).toHaveTextContent('Newest first')
  })

  it('reflects the current mode in the trigger label', () => {
    renderPicker({ sort: 'name-desc' })
    expect(screen.getByRole('button', { name: 'Sort order' })).toHaveTextContent('Name Z→A')
  })

  it('does not open the panel until the trigger is clicked', () => {
    renderPicker()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('offers the four orderings', async () => {
    const user = userEvent.setup()
    renderPicker()
    await user.click(screen.getByRole('button', { name: 'Sort order' }))

    const options = screen.getAllByRole('menuitemradio')
    expect(options).toHaveLength(4)
    expect(options.map((option) => option.textContent)).toEqual([
      'Newest first',
      'Oldest first',
      'Name A→Z',
      'Name Z→A'
    ])
  })

  it('marks exactly the active ordering', async () => {
    const user = userEvent.setup()
    renderPicker({ sort: 'taken-asc' })
    await user.click(screen.getByRole('button', { name: 'Sort order' }))

    const checked = screen.getAllByRole('menuitemradio', { checked: true })
    expect(checked).toHaveLength(1)
    expect(checked[0]).toHaveTextContent('Oldest first')
  })

  it('emits the chosen mode and closes the panel', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderPicker({ onChange })

    await user.click(screen.getByRole('button', { name: 'Sort order' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'Oldest first' }))

    expect(onChange).toHaveBeenCalledWith('taken-asc')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    renderPicker()
    await user.click(screen.getByRole('button', { name: 'Sort order' }))

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('closes on a click outside', async () => {
    const user = userEvent.setup()
    renderPicker()
    await user.click(screen.getByRole('button', { name: 'Sort order' }))

    await user.click(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('translates the labels', async () => {
    const user = userEvent.setup()
    renderPicker({}, 'zh-CN')
    await user.click(screen.getByRole('button', { name: '排序方式' }))

    expect(screen.getByRole('menuitemradio', { name: '最新优先' })).toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: '最早优先' })).toBeInTheDocument()
  })

  it('falls back to French labels', async () => {
    const user = userEvent.setup()
    renderPicker({}, 'fr')
    await user.click(screen.getByRole('button', { name: 'Ordre de tri' }))

    expect(screen.getByRole('menuitemradio', { name: 'Plus récentes' })).toBeInTheDocument()
  })

  it('reuses the menu panel so it does not drag the window', async () => {
    const user = userEvent.setup()
    renderPicker()
    await user.click(screen.getByRole('button', { name: 'Sort order' }))

    // `.menu-panel` carries `-webkit-app-region: no-drag`; without it the
    // toolbar's drag region would swallow clicks on the options.
    expect(document.querySelector('.menu-panel')).toBeInTheDocument()
  })
})
