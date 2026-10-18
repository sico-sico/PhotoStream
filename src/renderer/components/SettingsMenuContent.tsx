import { RING_SIZE_RANGE } from '@shared/types'
import { useI18n } from '../i18n/context'

export interface SettingsMenuContentProps {
  /** Called after any change, so the menu can close itself. */
  onDone: () => void
  /** Opens the About dialog. The menu closes first, so it does not linger above it. */
  onAbout: () => void
  /** Whether subfolder JPEGs are included. */
  recursive: boolean
  /**
   * Applied immediately and re-scans the open folder.
   *
   * Unlike the language picker this does not close the menu: re-scanning is
   * visible behind the panel, so the user can turn it on, watch the count
   * change, and turn it back off without reopening the menu.
   */
  onRecursiveChange: (recursive: boolean) => void
  /** How many photos the random show rings around the centre one. */
  ringSize: number
  /** Applied immediately; the ring re-deals without waiting for a turnover. */
  onRingSizeChange: (ringSize: number) => void
}

/**
 * Contents of the gear menu.
 *
 * Everything here is a preference rather than a per-photo action, which is why
 * it does not deserve permanent toolbar space: the language picker alone was a
 * full-width select box on a bar that also had to hold the folder, layouts,
 * filters, sort order, photo count and window buttons.
 */
export function SettingsMenuContent({
  onDone,
  onAbout,
  recursive,
  onRecursiveChange,
  ringSize,
  onRingSizeChange
}: SettingsMenuContentProps): React.JSX.Element {
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

      <label className="settings-check">
        <input
          type="checkbox"
          checked={recursive}
          onChange={(event) => onRecursiveChange(event.target.checked)}
        />
        <span>{t('settings.recursive')}</span>
      </label>

      {/*
        Ring size.

        A slider rather than a number box: the useful range is narrow and the
        only way to know which value suits a screen is to see the ring change, so
        the control is meant to be dragged while the show is open behind it. The
        value is shown as a number because "70" is otherwise unreadable from a
        thumb's position.
      */}
      <label className="settings-field">
        <span>
          {t('settings.ringSize')}
          {/* Tabular digits, so dragging does not make the label jitter. */}
          <span className="settings-value">{ringSize}</span>
        </span>
        <input
          type="range"
          min={RING_SIZE_RANGE.min}
          max={RING_SIZE_RANGE.max}
          step={5}
          value={ringSize}
          aria-label={t('settings.ringSize')}
          onChange={(event) => onRingSizeChange(Number(event.target.value))}
        />
      </label>

      <button
        type="button"
        className="button ghost settings-action"
        onClick={() => {
          // Close first: two stacked popups would fight over Escape and focus.
          onDone()
          onAbout()
        }}
      >
        {t('about.title')}
      </button>
    </div>
  )
}
