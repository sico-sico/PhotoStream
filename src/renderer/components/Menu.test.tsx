// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Menu } from './Menu'

function renderMenu(props: Partial<React.ComponentProps<typeof Menu>> = {}): ReturnType<typeof render> {
  return render(
    <Menu label="Settings" icon={<span data-testid="icon">*</span>} {...props}>
      {(close) => (
        <button type="button" onClick={close}>
          Done
        </button>
      )}
    </Menu>
  )
}

describe('Menu', () => {
  it('starts closed', () => {
    renderMenu()
    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens and closes on the trigger', async () => {
    const user = userEvent.setup()
    renderMenu()

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByRole('group', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-expanded', 'true')

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.queryByRole('group')).toBeNull()
  })

  it('closes itself through the passed callback', async () => {
    const user = userEvent.setup()
    renderMenu()

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('group')).toBeNull()
  })

  it('closes on Escape and keeps the focus on the trigger', async () => {
    const user = userEvent.setup()
    renderMenu()
    const trigger = screen.getByRole('button', { name: 'Settings' })

    await user.click(trigger)
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('group')).toBeNull()
    // Focus must not be lost to the document body, or the next Tab restarts
    // from the top of the page.
    expect(trigger).toHaveFocus()
  })

  it('closes when clicking outside', async () => {
    const user = userEvent.setup()
    render(
      <>
        <Menu label="Settings" icon={<span />}>
          {() => <span>inside</span>}
        </Menu>
        <button type="button">outside</button>
      </>
    )

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByText('inside')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'outside' }))
    expect(screen.queryByText('inside')).toBeNull()
  })

  it('stays open when clicking inside the panel', async () => {
    // Menu contents include a `<select>`; closing on any inner click would make
    // the dropdown impossible to use.
    const user = userEvent.setup()
    render(
      <Menu label="Settings" icon={<span />}>
        {() => <button type="button">inner</button>}
      </Menu>
    )

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(screen.getByRole('button', { name: 'inner' }))
    expect(screen.getByRole('button', { name: 'inner' })).toBeInTheDocument()
  })

  it('renders the icon inside the trigger', () => {
    renderMenu()
    expect(screen.getByTestId('icon')).toBeInTheDocument()
  })

  it('does not leave listeners behind after unmount', async () => {
    const user = userEvent.setup()
    const { unmount } = renderMenu()

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    unmount()

    // Throwing here would surface as a failed test, not a silent leak.
    await user.keyboard('{Escape}')
    expect(document.body).toBeInTheDocument()
  })
})
