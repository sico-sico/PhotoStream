import { useI18n } from '../i18n/context'

export interface SettingsMenuContentProps {
  /** Called after any change, so the menu can close itself. */
  onDone: () => void
}

/**
 * Contents of the gear menu.
 *
 * Everything here is a preference rather than a per-photo action, which is why
 * it does not deserve permanent toolbar space: the language picker alone was a
 * full-width select box on a bar that also had to hold the folder, layouts,
 * filters, sort order, photo count and window buttons.
 */
export function SettingsMenuContent({ onDone }: SettingsMenuContentProps): React.JSX.Element {
  const { locale, available, setLocale, t } = useI18n()

  return (
    <div className="settings-menu">
      {/* A single language is not a choice; showing the row would be a dead control. */}
      {available.length > 1 ? (
        <label className="settings-field">
          <span>{t('toolbar.language')}</span>
          <select
            aria-label={t('toolbar.language')}
            value={locale}
            onChange={(event) => {
              setLocale(event.target.value)
              onDone()
            }}
          >
            {available.map((definition) => (
              <option key={definition.id} value={definition.id}>
                {definition.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  )
}
