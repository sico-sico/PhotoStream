import { useMemo } from 'react'
import type { Filters } from '@shared/types'
import { dateRange } from '@shared/filters'
import type { Photo } from '@shared/types'
import { useI18n } from '../i18n/context'

export interface FilterPanelProps {
  filters: Filters
  photos: readonly Photo[]
  onChange: (filters: Filters) => void
  onReset: () => void
}

/**
 * Collapsible filter panel: capture-date range plus a file-name search.
 *
 * Dates come from EXIF, so the picker hints show the range actually present in
 * the folder rather than an arbitrary calendar.
 *
 * The photo count is deliberately *not* repeated here: the toolbar already
 * shows `visible/total` permanently, and rendering it twice put two identical
 * numbers on top of each other whenever this panel was open.
 */
export function FilterPanel({ filters, photos, onChange, onReset }: FilterPanelProps): React.JSX.Element {
  const { t } = useI18n()
  const range = useMemo(() => dateRange(photos), [photos])
  const active = Boolean(filters.from || filters.to || filters.text)

  return (
    <section className="filter-panel" aria-label={t('filters.aria')}>
      <div className="filter-row">
        <label className="filter-field">
          <span>{t('filters.from')}</span>
          <input
            type="date"
            value={filters.from}
            min={range.min || undefined}
            max={range.max || undefined}
            onChange={(event) => onChange({ ...filters, from: event.target.value })}
          />
        </label>
        <label className="filter-field">
          <span>{t('filters.to')}</span>
          <input
            type="date"
            value={filters.to}
            min={range.min || undefined}
            max={range.max || undefined}
            onChange={(event) => onChange({ ...filters, to: event.target.value })}
          />
        </label>
        <label className="filter-field grow">
          <span>{t('filters.fileName')}</span>
          <input
            type="search"
            placeholder={t('filters.fileNamePlaceholder')}
            value={filters.text}
            onChange={(event) => onChange({ ...filters, text: event.target.value })}
          />
        </label>
        <button type="button" className="button ghost" onClick={onReset} disabled={!active}>
          {t('filters.reset')}
        </button>
      </div>

      {range.min && range.max ? (
        <p className="filter-summary">
          {t('filters.range', { min: range.min, max: range.max })}
          {active ? ` · ${t('filters.active')}` : ''}
        </p>
      ) : active ? (
        <p className="filter-summary">{t('filters.active')}</p>
      ) : null}
    </section>
  )
}
