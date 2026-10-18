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
  return render(
    <I18nProvider preference={locale} systemLocales={[]} onLocaleChange={() => {}}>
      <SettingsMenuContent onDone={() => {}} {...props} />
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
})
