// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nProvider } from '../i18n/I18nProvider'
import { AboutDialog } from './AboutDialog'

const INFO = {
  version: '0.1.0',
  dataDir: 'C:\\Users\\me\\PhotoStreamData',
  thumbCacheDir: 'C:\\Users\\me\\PhotoStreamData\\thumbs',
  systemLocales: ['en'],
  electron: '44.9.0',
  chromium: '152.0.7977.167'
}

function renderDialog(locale = 'en', onClose = () => {}): ReturnType<typeof render> {
  vi.spyOn(window.photoStream, 'appInfo').mockResolvedValue(INFO)
  return render(
    <I18nProvider preference={locale} systemLocales={[]} onLocaleChange={() => {}}>
      <AboutDialog onClose={onClose} />
    </I18nProvider>
  )
}

describe('AboutDialog', () => {
  it('is a labelled modal dialog', () => {
    renderDialog()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleName(/about photostream/i)
  })

  it('shows the version once appInfo resolves', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByText('Version 0.1.0')).toBeInTheDocument())
  })

  it('shows the runtime versions so a bug report can name them', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByText('44.9.0')).toBeInTheDocument())
    expect(screen.getByText('152.0.7977.167')).toBeInTheDocument()
  })

  it('shows the data folder', async () => {
    renderDialog()
    await waitFor(() => expect(screen.getByText(INFO.dataDir)).toBeInTheDocument())
  })

  it('links to the source repository', () => {
    renderDialog()
    const link = screen.getByRole('link', { name: 'sico-sico/PhotoStream' })
    expect(link).toHaveAttribute('href', 'https://github.com/sico-sico/PhotoStream')
  })

  it('states the licence and links to its text', () => {
    renderDialog()
    expect(screen.getByText('License')).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'MIT' })
    expect(link).toHaveAttribute('href', 'https://github.com/sico-sico/PhotoStream/blob/main/LICENSE')
    // Same reason as the repository link: only `_blank` reaches the browser.
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('links to the third-party notices and names the copyleft component', () => {
    // libvips is LGPL: the about box has to say so, not bury it in a file.
    renderDialog()
    const link = screen.getByRole('link', { name: 'THIRD-PARTY-NOTICES.md' })
    expect(link).toHaveAttribute('href', 'https://github.com/sico-sico/PhotoStream/blob/main/THIRD-PARTY-NOTICES.md')
    expect(link).toHaveAttribute('target', '_blank')
    expect(screen.getByText(/libvips \(LGPL-3\.0-or-later\)/)).toBeInTheDocument()
  })

  it('translates the licence rows', () => {
    renderDialog('zh-CN')
    expect(screen.getByText('许可协议')).toBeInTheDocument()
    expect(screen.getByText('第三方组件许可')).toBeInTheDocument()
    expect(screen.getByText(/libvips（LGPL-3\.0-or-later）/)).toBeInTheDocument()
  })

  it('credits the model that wrote the code', () => {
    // Honest attribution for a codebase generated end to end, and a hint about
    // whose quirks a bug report is dealing with.
    renderDialog()
    expect(screen.getByText('Written by')).toBeInTheDocument()
    expect(screen.getByText('GitHub Copilot (DeepSeek V4 Flash)')).toBeInTheDocument()
  })

  it('translates the credit line', () => {
    renderDialog('zh-CN')
    expect(screen.getByText('代码作者')).toBeInTheDocument()
    expect(screen.getByText('GitHub Copilot（DeepSeek V4 Flash）')).toBeInTheDocument()
  })

  it('opens the repository in the real browser, not in the app window', () => {
    // The main process denies in-window navigation, so the link must target a
    // new window for `setWindowOpenHandler` to hand it to `shell.openExternal`.
    renderDialog()
    const link = screen.getByRole('link', { name: 'sico-sico/PhotoStream' })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
  })

  it('still renders when appInfo fails', async () => {
    vi.spyOn(window.photoStream, 'appInfo').mockRejectedValue(new Error('nope'))
    render(
      <I18nProvider preference="en" systemLocales={[]} onLocaleChange={() => {}}>
        <AboutDialog onClose={() => {}} />
      </I18nProvider>
    )
    // The dialog is useful for its shortcuts even without the version block.
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Keyboard shortcuts')).toBeInTheDocument()
  })

  it('moves focus to the close button on open', () => {
    renderDialog()
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
  })

  it('closes on the close button', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderDialog('en', onClose)

    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderDialog('en', onClose)

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on a backdrop click but not on a click inside the panel', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderDialog('en', onClose)

    await user.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()

    await user.click(document.querySelector('.about-backdrop') as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('lists the shortcuts in the active language', () => {
    renderDialog('zh-CN')
    expect(screen.getByText('键盘快捷键')).toBeInTheDocument()
    expect(screen.getByText('方向键 — 平移照片墙')).toBeInTheDocument()
  })

  it('is translated to French', () => {
    renderDialog('fr')
    expect(screen.getByText('Raccourcis clavier')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fermer' })).toBeInTheDocument()
  })
})
