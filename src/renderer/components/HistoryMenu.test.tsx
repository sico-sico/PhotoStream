// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nProvider } from '../i18n/I18nProvider'
import { HistoryMenu } from './HistoryMenu'

function renderMenu(
  props: Partial<React.ComponentProps<typeof HistoryMenu>> = {},
  locale = 'en'
): ReturnType<typeof render> {
  return render(
    <I18nProvider preference={locale} systemLocales={[]} onLocaleChange={() => {}}>
      <HistoryMenu
        history={['/photos/trip', '/photos/2019']}
        current="/photos/trip"
        onOpen={() => {}}
        onRemove={() => {}}
        onClear={() => {}}
        {...props}
      />
    </I18nProvider>
  )
}

describe('HistoryMenu', () => {
  it('renders nothing when there is no history', () => {
    renderMenu({ history: [] })
    // An empty dropdown is a dead control; the trigger should not exist at all.
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('shows a trigger once there is history', () => {
    renderMenu()
    expect(screen.getByRole('button', { name: 'Recent folders' })).toBeInTheDocument()
  })

  it('does not open the panel until the trigger is clicked', () => {
    renderMenu()
    expect(screen.queryByText('Recent folders', { selector: '.history-heading' })).not.toBeInTheDocument()
  })

  it('lists the folders newest first', async () => {
    const user = userEvent.setup()
    renderMenu()
    await user.click(screen.getByRole('button', { name: 'Recent folders' }))

    const names = screen.getAllByRole('listitem').map((item) => item.querySelector('.history-name')?.textContent)
    expect(names).toEqual(['trip', '2019'])
  })

  it('shows each folder’s full path so look-alike names are distinguishable', async () => {
    const user = userEvent.setup()
    renderMenu()
    await user.click(screen.getByRole('button', { name: 'Recent folders' }))

    expect(screen.getByText('/photos/trip')).toBeInTheDocument()
    expect(screen.getByText('/photos/2019')).toBeInTheDocument()
  })

  it('marks the folder that is currently open', async () => {
    const user = userEvent.setup()
    renderMenu()
    await user.click(screen.getByRole('button', { name: 'Recent folders' }))

    expect(screen.getByRole('button', { current: true })).toHaveAccessibleName(/trip/)
  })

  it('opens a folder and closes the panel', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    renderMenu({ onOpen })
    await user.click(screen.getByRole('button', { name: 'Recent folders' }))

    // Located by class: `/2019/` would also match the "Forget 2019" button.
    await user.click(document.querySelectorAll('.history-open')[1] as HTMLElement)
    expect(onOpen).toHaveBeenCalledWith('/photos/2019')
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })

  it('removes one folder without closing the panel', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    renderMenu({ onRemove })
    await user.click(screen.getByRole('button', { name: 'Recent folders' }))

    await user.click(screen.getByRole('button', { name: 'Forget 2019' }))
    expect(onRemove).toHaveBeenCalledWith('/photos/2019')
    // The panel stays open so a second folder can be removed straight away.
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('names the removal button after the folder, not just "remove"', async () => {
    const user = userEvent.setup()
    renderMenu()
    await user.click(screen.getByRole('button', { name: 'Recent folders' }))

    // Two identical "remove" buttons would be unusable with a screen reader.
    expect(screen.getByRole('button', { name: 'Forget trip' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Forget 2019' })).toBeInTheDocument()
  })

  it('clears every folder', async () => {
    const user = userEvent.setup()
    const onClear = vi.fn()
    renderMenu({ onClear })
    await user.click(screen.getByRole('button', { name: 'Recent folders' }))

    await user.click(screen.getByRole('button', { name: 'Clear all' }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    renderMenu()
    await user.click(screen.getByRole('button', { name: 'Recent folders' }))

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })

  it('closes on a click outside', async () => {
    const user = userEvent.setup()
    renderMenu()
    await user.click(screen.getByRole('button', { name: 'Recent folders' }))

    await user.click(document.body)
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })

  it('is translated', async () => {
    const user = userEvent.setup()
    renderMenu({}, 'zh-CN')
    await user.click(screen.getByRole('button', { name: '最近的文件夹' }))

    const panel = document.querySelector('.history-panel') as HTMLElement
    expect(within(panel).getByText('全部清除')).toBeInTheDocument()
  })

  it('keeps the panel inside the toolbar drag strip opt-out', async () => {
    const user = userEvent.setup()
    renderMenu()
    await user.click(screen.getByRole('button', { name: 'Recent folders' }))

    // Reuses `.menu-panel`, which carries `-webkit-app-region: no-drag`; without
    // it the panel would drag the window instead of receiving clicks.
    expect(document.querySelector('.menu-panel')).toBeInTheDocument()
  })
})
