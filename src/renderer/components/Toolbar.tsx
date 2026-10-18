import type { LayoutMode } from '@shared/types'
import type { MessageKey } from '@shared/i18n/messages'
import { useI18n } from '../i18n/context'
import { LanguagePicker } from './LanguagePicker'

export interface ToolbarProps {
  dir: string
  layout: LayoutMode
  filtersOpen: boolean
  progress: { done: number; total: number } | null
  busy: boolean
  visibleCount: number
  totalCount: number
  onChooseFolder: () => void
  onLayoutChange: (layout: LayoutMode) => void
  onToggleFilters: () => void
}

const LAYOUTS: ReadonlyArray<{ value: LayoutMode; label: MessageKey; hint: MessageKey }> = [
  { value: 'grid', label: 'toolbar.layoutGrid', hint: 'toolbar.layoutGridHint' },
  { value: 'masonry', label: 'toolbar.layoutMasonry', hint: 'toolbar.layoutMasonryHint' },
  { value: 'square', label: 'toolbar.layoutSquare', hint: 'toolbar.layoutSquareHint' }
]

export function Toolbar({
  dir,
  layout,
  filtersOpen,
  progress,
  busy,
  visibleCount,
  totalCount,
  onChooseFolder,
  onLayoutChange,
  onToggleFilters
}: ToolbarProps): React.JSX.Element {
  const { t } = useI18n()

  return (
    <header className="toolbar">
      <button type="button" className="button primary" onClick={onChooseFolder}>
        {t('toolbar.openFolder')}
      </button>

      <div className="dir-label" title={dir} dir="auto">
        {busy ? t('toolbar.scanning') : dir || t('toolbar.noFolder')}
      </div>

      <div className="layout-switch" role="group" aria-label={t('toolbar.layoutAria')}>
        {LAYOUTS.map((item) => (
          <button
            key={item.value}
            type="button"
            className={`button chip ${layout === item.value ? 'active' : ''}`}
            title={t(item.hint)}
            aria-pressed={layout === item.value}
            onClick={() => onLayoutChange(item.value)}
          >
            {t(item.label)}
          </button>
        ))}
      </div>

      <button
        type="button"
        className={`button ghost ${filtersOpen ? 'active' : ''}`}
        aria-expanded={filtersOpen}
        onClick={onToggleFilters}
      >
        {t('toolbar.filters')}
      </button>

      <div className="toolbar-stats">
        <span>
          {visibleCount}/{totalCount}
        </span>
        {progress && progress.total > 0 ? (
          <span className="progress" title={t('toolbar.thumbsTitle')}>
            {progress.done}/{progress.total}
          </span>
        ) : null}
      </div>

      <LanguagePicker />
    </header>
  )
}
