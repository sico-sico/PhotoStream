// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nProvider } from '../i18n/I18nProvider'
import { SettingsMenuContent } from './SettingsMenuContent'

function renderContent(
  props: Partial<React.ComponentProps<typeof SettingsMenuContent>> = {},
  locale = 'en'
): ReturnType<typeof render> {
  // Defaults first, overrides after: `Partial` makes every prop optional, so
  // spreading first would let `undefined` overwrite a required value.
  const merged = {
    onDone: () => {},
    onAbout: () => {},
    recursive: false,
    onRecursiveChange: () => {},
    ...props
  }
  return render(
    <I18nProvider preference={locale} systemLocales={[]} onLocaleChange={() => {}}>
      <SettingsMenuContent {...merged} />
    </I18nProvider>
  )
}

describe('SettingsMenuContent', () => {
  it('offers the language picker', () => {
    renderContent()
    expect(screen.getByLabelText('Language')).toBeInTheDocument()
    expect(screen.getAllByRole('option').length).toBeGreaterThan(1)
  })

  it('reflects the active language', () => {
    renderContent({}, 'fr')
    expect((screen.getByLabelText(/langue/i) as HTMLSelectElement).value).toBe('fr')
  })

  it('reports that the change is done so the menu can close', async () => {
    const user = userEvent.setup()
    const onDone = vi.fn()
    renderContent({ onDone })

    await user.selectOptions(screen.getByLabelText('Language'), 'zh-CN')
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('labels the field in the active language', () => {
    renderContent({}, 'zh-CN')
    // The row heading, not just the select's accessible name.
    expect(screen.getByText('语言')).toBeInTheDocument()
  })

  it('offers the subfolder toggle, off by default', () => {
    renderContent()
    expect(screen.getByRole('checkbox', { name: /subfolders/i })).not.toBeChecked()
  })

  it('reflects an enabled subfolder setting', () => {
    renderContent({ recursive: true })
    expect(screen.getByRole('checkbox', { name: /subfolders/i })).toBeChecked()
  })

  it('reports the new subfolder value', async () => {
    const user = userEvent.setup()
    const onRecursiveChange = vi.fn()
    renderContent({ onRecursiveChange })

    await user.click(screen.getByRole('checkbox', { name: /subfolders/i }))
    expect(onRecursiveChange).toHaveBeenCalledWith(true)
  })

  it('does not close the menu when the subfolder toggle changes', async () => {
    // The re-scan is visible behind the panel, so the user can turn it on, watch
    // the count change, and turn it back off. Closing after one click would make
    // that impossible.
    const user = userEvent.setup()
    const onDone = vi.fn()
    renderContent({ onDone })

    await user.click(screen.getByRole('checkbox', { name: /subfolders/i }))
    expect(onDone).not.toHaveBeenCalled()
  })

  it('translates the subfolder label', () => {
    renderContent({}, 'zh-CN')
    expect(screen.getByRole('checkbox', { name: '包含子文件夹中的照片' })).toBeInTheDocument()
  })
})
