import { useI18n } from '../i18n/context'

/**
 * Language picker.
 *
 * Rendered as a native `<select>` rather than a custom menu: it is keyboard and
 * screen-reader accessible for free, and the locale list is data-driven, so a
 * locale injected via `locales.register()` appears here without further work.
 */
export function LanguagePicker(): React.JSX.Element | null {
  const { locale, available, setLocale, t } = useI18n()

  // A single language is not a choice; hide the control instead of showing a
  // dead dropdown.
  if (available.length < 2) return null

  return (
    <label className="language-picker" title={t('toolbar.language')}>
      <span className="visually-hidden">{t('toolbar.language')}</span>
      <select
        aria-label={t('toolbar.language')}
        value={locale}
        onChange={(event) => setLocale(event.target.value)}
      >
        {available.map((definition) => (
          <option key={definition.id} value={definition.id}>
            {definition.label}
          </option>
        ))}
      </select>
    </label>
  )
}
