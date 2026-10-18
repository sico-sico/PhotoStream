// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nProvider } from '../i18n/I18nProvider'
import { WindowControls } from './WindowControls'

/** Install a fake bridge so each test controls what the window reports. */
function installBridge(overrides: Partial<Record<'isMaximized' | 'toggleMaximize', () => Promise<boolean>>> = {}): void {
  Object.defineProperty(window, 'photoStream', {
    configurable: true,
    writable: true,
    value: {
      minimize: vi.fn().mockResolvedValue(undefined),
      toggleMaximize: vi.fn(overrides.toggleMaximize ?? (async () => false)),
      close: vi.fn().mockResolvedValue(undefined),
      isMaximized: vi.fn(overrides.isMaximized ?? (async () => false)),
      onWindowState: vi.fn().mockReturnValue(() => {})
    }
  })
}

function renderControls(locale = 'en'): ReturnType<typeof render> {
  return render(
    <I18nProvider preference={locale} systemLocales={[]} onLocaleChange={() => {}}>
      <WindowControls />
    </I18nProvider>
  )
}

beforeEach(() => {
  installBridge()
})

describe('WindowControls', () => {
  it('renders all three window buttons', () => {
    renderControls()
    expect(screen.getByRole('button', { name: 'Minimize' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Maximize' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
  })

  it('minimises the window', async () => {
    const user = userEvent.setup()
    renderControls()

    await user.click(screen.getByRole('button', { name: 'Minimize' }))
    expect(window.photoStream.minimize).toHaveBeenCalledTimes(1)
  })

  it('closes the window', async () => {
    const user = userEvent.setup()
    renderControls()

    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(window.photoStream.close).toHaveBeenCalledTimes(1)
  })

  it('toggles maximise and reflects the new state', async () => {
    const user = userEvent.setup()
    installBridge({ toggleMaximize: async () => true })
    renderControls()

    await user.click(screen.getByRole('button', { name: 'Maximize' }))

    expect(window.photoStream.toggleMaximize).toHaveBeenCalledTimes(1)
    // Once maximised the affordance becomes "restore".
    expect(await screen.findByRole('button', { name: 'Restore' })).toBeInTheDocument()
  })

  it('reads the initial maximised state', async () => {
    installBridge({ isMaximized: async () => true })
    renderControls()

    expect(await screen.findByRole('button', { name: 'Restore' })).toBeInTheDocument()
  })

  it('follows window state pushed from the main process', async () => {
    const onWindowState = vi.fn().mockReturnValue(() => {})
    Object.defineProperty(window, 'photoStream', {
      configurable: true,
      writable: true,
      value: {
        minimize: vi.fn(),
        toggleMaximize: vi.fn().mockResolvedValue(false),
        close: vi.fn(),
        isMaximized: vi.fn().mockResolvedValue(false),
        onWindowState
      }
    })

    renderControls()
    expect(screen.getByRole('button', { name: 'Maximize' })).toBeInTheDocument()

    // The subscription is registered in an effect, so read the callback from
    // the mock rather than capturing it during render.
    await waitFor(() => expect(onWindowState).toHaveBeenCalled())
    const listener = onWindowState.mock.calls[0][0] as (maximized: boolean) => void

    // Maximising via a double-click on the title bar never goes through these
    // buttons, so the main process has to be able to tell the UI.
    await act(async () => {
      listener(true)
    })
    expect(await screen.findByRole('button', { name: 'Restore' })).toBeInTheDocument()
  })

  it('unsubscribes on unmount', () => {
    const unsubscribe = vi.fn()
    Object.defineProperty(window, 'photoStream', {
      configurable: true,
      writable: true,
      value: {
        minimize: vi.fn(),
        toggleMaximize: vi.fn(),
        close: vi.fn(),
        isMaximized: vi.fn().mockResolvedValue(false),
        onWindowState: vi.fn().mockReturnValue(unsubscribe)
      }
    })

    const { unmount } = renderControls()
    unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('localises the button labels', () => {
    renderControls('zh-CN')
    expect(screen.getByRole('button', { name: '最小化' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '最大化' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument()
  })
})
