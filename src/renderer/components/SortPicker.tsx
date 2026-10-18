import type { MessageKey } from '@shared/i18n/messages'
import type { SortMode } from '@shared/types'
import { useI18n } from '../i18n/context'

/**
 * Wall ordering picker.
 *
 * A native `<select>` for the same reasons as `LanguagePicker`: keyboard and
 * screen-reader support come for free, and it costs one control instead of a
 * row of chips in an already busy toolbar.
 */
const OPTIONS: ReadonlyArray<{ value: SortMode; label: MessageKey }> = [
  { value: 'taken-desc', label: 'toolbar.sortNewest' },
  { value: 'taken-asc', label: 'toolbar.sortOldest' },
  { value: 'name-asc', label: 'toolbar.sortNameAsc' },
  { value: 'name-desc', label: 'toolbar.sortNameDesc' }
]

export interface SortPickerProps {
  sort: SortMode
  onChange: (sort: SortMode) => void
}

export function SortPicker({ sort, onChange }: SortPickerProps): React.JSX.Element {
  const { t } = useI18n()

  return (
    <label className="sort-picker" title={t('toolbar.sort')}>
      <span className="visually-hidden">{t('toolbar.sort')}</span>
      <select
        aria-label={t('toolbar.sort')}
        value={sort}
        // The value comes from a fixed option list, but it crosses into a
        // reducer, so anything unrecognised falls back rather than persisting a
        // mode that would leave the wall unsorted.
        onChange={(event) => {
          const next = OPTIONS.find((option) => option.value === event.target.value)
          if (next) onChange(next.value)
        }}
      >
        {OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {t(option.label)}
          </option>
        ))}
      </select>
    </label>
  )
}
