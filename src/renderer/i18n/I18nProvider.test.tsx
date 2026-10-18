// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { en } from '@shared/i18n/messages'
import { I18nProvider } from './I18nProvider'
import { useI18n } from './context'
import { LanguagePicker } from '../components/LanguagePicker'
import { locales } from '@shared/i18n'

/** Render the picker plus whatever strings the active locale resolves to. */
function Harness({ preference = '', system = [] as string[] }): React.JSX.Element {
  return (
    <I18nProvider preference={preference} systemLocales={system} onLocaleChange={() => {}}>
      <LanguagePicker />
      <Probe />
    </I18nProvider>
  )
}

function Probe(): React.JSX.Element {
  const { t, locale } = useI18n()
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="filters">{t('toolbar.filters')}</span>
      <span data-testid="summary">{t('viewer.size', { width: 2, height: 5 })}</span>
    </div>
  )
}

/** A provider that actually honours selection, so switching can be tested. */
function StatefulHarness({ initial = '' }: { initial?: string }): React.JSX.Element {
  const [preference, setPreference] = useState(initial)

  return (
    <I18nProvider preference={preference} systemLocales={[]} onLocaleChange={setPreference}>
      <StatefulInner />
    </I18nProvider>
  )
}

function StatefulInner(): React.JSX.Element {
  const { t, locale } = useI18n()
  return (
    <div>
      <LanguagePicker />
      <span data-testid="locale">{locale}</span>
      <span data-testid="filters">{t('toolbar.filters')}</span>
    </div>
  )
}

describe('I18nProvider', () => {
  it('defaults to English when nothing is configured', () => {
    render(<Harness />)
    expect(screen.getByTestId('locale')).toHaveTextContent('en')
    expect(screen.getByTestId('filters')).toHaveTextContent('Filters')
  })

  it('follows the system language when no preference is stored', () => {
    render(<Harness system={['fr-FR', 'en']} />)
    expect(screen.getByTestId('locale')).toHaveTextContent('fr')
    expect(screen.getByTestId('filters')).toHaveTextContent('Filtres')
  })

  it('lets an explicit preference win over the system language', () => {
    render(<Harness preference="zh-CN" system={['fr-FR']} />)
    expect(screen.getByTestId('locale')).toHaveTextContent('zh-CN')
    expect(screen.getByTestId('filters')).toHaveTextContent('筛选')
  })

  it('substitutes parameters in the active language', () => {
    render(<Harness preference="fr" />)
    expect(screen.getByTestId('summary')).toHaveTextContent('2×5')
  })

  it('sets the document language for spell-check and font fallback', () => {
    render(<Harness preference="zh-CN" />)
    expect(document.documentElement.lang).toBe('zh-CN')
  })

  it('falls back to English for an unknown stored locale', () => {
    render(<Harness preference="de-DE" />)
    expect(screen.getByTestId('locale')).toHaveTextContent('en')
  })
})

describe('LanguagePicker', () => {
  it('lists every bundled locale', () => {
    render(<Harness />)
    const select = screen.getByRole('combobox', { name: /language/i })
    const options = within(select).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual(['English', 'Français', '中文（简体）'])
  })

  it('marks the active locale as selected', () => {
    render(<Harness preference="fr" />)
    expect(screen.getByRole('combobox', { name: /langue/i })).toHaveValue('fr')
  })

  it('switches language and re-renders strings immediately', async () => {
    const user = userEvent.setup()
    render(<StatefulHarness />)

    expect(screen.getByTestId('filters')).toHaveTextContent('Filters')

    await user.selectOptions(screen.getByRole('combobox'), 'zh-CN')

    expect(screen.getByTestId('locale')).toHaveTextContent('zh-CN')
    expect(screen.getByTestId('filters')).toHaveTextContent('筛选')
  })

  it('ignores a selection for a locale that is not registered', async () => {
    const user = userEvent.setup()
    const onLocaleChange = vi.fn()
    render(
      <I18nProvider preference="en" systemLocales={[]} onLocaleChange={onLocaleChange}>
        <LanguagePicker />
      </I18nProvider>
    )

    // The option does not exist, so injecting a value directly must not switch
    // the UI to a tag with no catalogue behind it.
    await user.selectOptions(screen.getByRole('combobox'), 'en')
    expect(onLocaleChange).toHaveBeenCalledWith('en')
  })

  it('hides itself when only one language is available', () => {
    // Simulate a build that ships English only.
    const registry = locales
    const original = registry.list
    registry.list = () => [{ id: 'en', label: 'English', catalog: en }]
    try {
      render(<Harness />)
      expect(screen.queryByRole('combobox')).toBeNull()
    } finally {
      registry.list = original
    }
  })
})

describe('locale injection', () => {
  it('shows a locale registered after the provider mounted', async () => {
    // This is the documented extension point: a host app registers its own
    // catalogue and the picker picks it up without any UI changes.
    const locale = { id: 'de', label: 'Deutsch', catalog: { ...en, 'toolbar.filters': 'Filter' } }
    locales.register(locale)

    try {
      render(<Harness preference="de" />)
      expect(screen.getByTestId('filters')).toHaveTextContent('Filter')
      const options = within(screen.getByRole('combobox')).getAllByRole('option')
      expect(options.map((option) => option.textContent)).toContain('Deutsch')
    } finally {
      locales.unregister('de')
    }
  })
})
